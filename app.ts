import { Readable, Writable } from 'stream';
import { Bucket, Storage } from '@google-cloud/storage';

const fs = require('fs');
const ImageAnnotatorClient = require('@google-cloud/vision').v1.ImageAnnotatorClient;
const TextToSpeech = require('@google-cloud/text-to-speech');
const PLimit = require('p-limit');

class GcsLib {
  private readonly bucket: Bucket;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
    this.bucket = new Storage().bucket(bucketName);
  }
  getBucketName(): string {
    return this.bucketName;
  }
  listFiles(prefix: string): Promise<Array<string>> {
    return this.bucket.getFiles({prefix, maxResults: 1000}).then(([files]) => {
      return files.map(f => f.name);
    });
  }
  writeStream(path: string, contentType: string): Writable {
    return this.bucket
      .file(path)
      .createWriteStream({
        metadata: { contentType },
      })
  }
  readStream(path: string): Readable {
    return this.bucket
      .file(path)
      .createReadStream();
  }
  readGcsFileString(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = '';
      this.readStream(path)
        .on('data', d => { buf += d; })
        .on('end', () => resolve(buf))
        .on('error', e => reject(e));
    });
  }
  combine(sourcePaths: Array<string>, destPath: string, metadata: Object = {}): Promise<void> {
    return this.bucket.combine(sourcePaths, destPath)
      .then(() => { return this.bucket.file(destPath).setMetadata(metadata); })
      .then(() => { return; });
  }
  copy(sourcePath: string, destPath: string): Promise<void> {
    return this.bucket.file(sourcePath).copy(this.bucket.file(destPath))
      .then(() => { return; });
  }
}

class ConcatMp3Task {
  private readonly gcs: GcsLib;
  private readonly maxConcurrency = 8;
  private readonly maxCombine = 32;

  constructor(gcs: GcsLib) {
    this.gcs = gcs;
  }
  run(files: Array<string>, outputPath: string): Promise<string> {
    console.log(`ConcatMp3Task.run(${JSON.stringify(files)}, ${outputPath})`);
    if (files.length === 0) {
      return Promise.reject('files are empty');
    }
    if (files.length === 1) {
      return this.gcs.copy(files[0], outputPath).then(() => outputPath);
    }
    const limit = PLimit(this.maxConcurrency);
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < files.length; i+=this.maxCombine) {
      const group = files.slice(i, i+this.maxCombine);
      const concatFilePath = this.getConcatFilePath(group);
      promises.push(limit(() => {
        return this.gcs.combine(group, concatFilePath, { contentType: 'audio/mpeg' }).then(() => concatFilePath);
      }));
    }
    return Promise.all(promises).then(newFiles => {
      return this.run(newFiles, outputPath)
    });
  }
  getConcatFilePath(files: Array<string>): string {
    const dir = require('path').dirname(files[0]);
    const s = files[0].replace(/^.*?-([0-9]{3}).*$/, '$1');
    const e = files.slice(-1)[0].replace(/^.*([0-9]{3})\.mp3$/, '$1');
    return `${dir}/concat-${s}-${e}.mp3`;
  }
}

class OcrTask {
  private readonly gcs: GcsLib;
  private readonly client: typeof ImageAnnotatorClient;

  constructor(gcs: GcsLib) {
    this.gcs = gcs;
    this.client = new ImageAnnotatorClient();
  }

  run(inputFilePath: string, outputPrefix: string): Promise<Array<string>> {
    console.log(`OcrTask.run(${inputFilePath}, ${outputPrefix})`);
    return this.gcs.listFiles(outputPrefix).then(listFiles => {
      if (listFiles.length > 0) {
        console.log(`already exists: ${listFiles}`);
        return listFiles;
      } else {
        // const outputPrefix = 'json/' + path.basename(fileName, '.pdf')
        const gcsSourceUri = `gs://${this.gcs.getBucketName()}/${inputFilePath}`;
        const gcsDestinationUri = `gs://${this.gcs.getBucketName()}/${outputPrefix}/`;
        const inputConfig = {
          mimeType: 'application/pdf',
          gcsSource: { uri: gcsSourceUri },
        };
        const outputConfig = { gcsDestination: { uri: gcsDestinationUri } };
        const features = [{type: 'DOCUMENT_TEXT_DETECTION'}];
        const request = {
          requests: [{
            inputConfig: inputConfig,
            features: features,
            outputConfig: outputConfig,
          }],
        };
        return this.client.asyncBatchAnnotateFiles(request).then(([operation]) => {
          return operation.promise();
        }).then(([res]) => {
          const destinationUri = res.responses[0].outputConfig.gcsDestination.uri;
          console.log('json saved to: ' + destinationUri);
          return this.gcs.listFiles(outputPrefix)
            .then(files => files.sort((a, b,) => this.ord(a) - this.ord(b)));
        });
      }
    });
  }
  ord(name: string): number {
    return parseInt(name.replace(/^.*?([0-9]+).*$/, '$1'), 10);
  }
}

class TextToSpeechTask {
  private readonly gcs: GcsLib;
  private readonly client: typeof TextToSpeech.TextToSpeechClient;
  private readonly languageCode: string;
  private readonly delimiter: string;
  private readonly maxConcurrency = 8;
  private readonly maxLength = 5000;

  constructor(gcs: GcsLib, languageCode: string, delimiter: string) {
    this.gcs = gcs;
    this.client = new TextToSpeech.TextToSpeechClient();
    this.languageCode = languageCode;
    this.delimiter = delimiter;
  }

  async run(gcsPaths: Array<string>, outputPrefix: string): Promise<Array<string>> {
    console.log(`TextToSpeechTask.run(${JSON.stringify(gcsPaths)}, ${outputPrefix})`);
    const existFiles = await this.gcs.listFiles(outputPrefix);
    const textsList = await Promise.all(gcsPaths.map(paths => this.readOcrOuputJson(paths)));

    console.log(JSON.stringify(textsList));
    if (1) { process.exit(1); }
    const texts = textsList.flat();
    let text = '';
    let num = 0;
    const limit = PLimit(this.maxConcurrency);
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if ((text + t).length > this.maxLength) {
        const outputPath = this.getOutputPath(outputPrefix, ++num);
        const chunk = JSON.parse(JSON.stringify(text));
        promises.push(limit(() => {
          if (existFiles.some(f => f.endsWith(outputPath))) {
            return Promise.resolve(outputPath);
          } else {
            return this.ttsRequest(chunk, outputPath);
          }
        }));
        text = '';
      }
      text += t;
    }
    if (text.length > 0) {
      const outputPath = this.getOutputPath(outputPrefix, ++num);
      const chunk = JSON.parse(JSON.stringify(text));
      promises.push(limit(() => {
        if (existFiles.some(f => f.endsWith(outputPath))) {
          return Promise.resolve(outputPath);
        } else {
          return this.ttsRequest(text, outputPath);
        }
      }));
    }
    return Promise.all(promises);
  }

  getOutputPath(prefix: string, num: number): string {
    const suffixString = `${(num < 10 ? '00' : (num < 100 ? '0' : ''))+num}`;
    const outputPath = `${prefix}/output-${suffixString}.mp3`;
    return outputPath;
  }

  ttsRequest(text: string, outputPath: string): Promise<string> {
    console.log(`ttsRequest(..., ${outputPath})`);
    const request = {
      input: {text: text},
      voice: {languageCode: this.languageCode, ssmlGender: 'NEUTRAL'},
      audioConfig: {audioEncoding: 'MP3'},
    };
    return this.client.synthesizeSpeech(request).then(([response]) => {
      return new Promise((resolve, reject) => {
        const w = this.gcs.writeStream(outputPath, 'audio/mpeg');
        w.write(response.audioContent);
        console.log(`ttsRequest(..., ${outputPath}) done.`);
        w.end('', 'binary', () => resolve(outputPath));
      });
    });
  }

  readOcrOuputJson(gcsPath: string): Promise<Array<string>> {
    console.log(`TextToSpeechTask.readOcrOuputJson(${gcsPath})`);
    return this.gcs.readGcsFileString(gcsPath).then(str => {
      const obj = JSON.parse(str);
      const ary = obj.responses.map(x => {
        return x.fullTextAnnotation ? x.fullTextAnnotation.pages.map(x => {
          return x.blocks.map(x => {
            return x.paragraphs.map(x => {
              return x.words.map(x => {
                return x.symbols.map(x => x.text);
              });
            });
          });
        }) : [];
      });
      return ary.flat().flat().flat().map(x => {
        return x.map(x => {
          return x.join("")
        }).flat().join("");
      }).map(x => {
        return x.endsWith(this.delimiter) ? x : (x+this.delimiter);
      });
    });
  }
}

const gcs = new GcsLib('pdf-audify');
const ocr = new OcrTask(gcs);
const tts = new TextToSpeechTask(gcs, 'ja-JP', '。');
const concat = new ConcatMp3Task(gcs);

const gcsPath = process.argv[2];
const basename = require('path').basename(gcsPath, '.pdf');
(async () => {
  await ocr.run(gcsPath, `dev/json/${basename}`)
   .then(files => tts.run(files, `dev/mp3/${basename}`))
   .then(files => concat.run(files, `dev/out/${basename}.mp3`))
})();

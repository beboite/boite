import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Private stdio worker: native decoding never blocks the core's RPC event loop. */
export async function runSpeechWorker(): Promise<void> {
  let recognizer: any;
  let stream: any;
  function samples(audio: string): Float32Array {
    const wav = Buffer.from(audio, 'base64');
    const pcm = new Float32Array((wav.length - 44) / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(44 + i * 2) / 32768;
    return pcm;
  }
  function begin(language: string): void {
    stream = recognizer.createStream();
    if (language) stream.setOption('language', language);
  }
  function decode(audio?: string, finish = false): { text: string } {
    if (!stream) throw new Error('speech stream is not open');
    if (audio) stream.acceptWaveform({ sampleRate: 16000, samples: samples(audio) });
    if (finish) {
      // Drain the acoustic lookahead. This padding is decoded, never played.
      stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) });
      stream.inputFinished();
    }
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (finish) stream = undefined;
    return { text };
  }
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request: any;
    try {
      request = JSON.parse(line);
      let result: unknown;
      switch (request.operation) {
        case 'init': {
          const require = createRequire(join(request.runtime, 'sherpa-onnx.js'));
          const { OnlineRecognizer } = require(join(request.runtime, 'streaming-asr.js'));
          const model = request.model;
          recognizer = new OnlineRecognizer({
            featConfig: { sampleRate: 16000, featureDim: 128 },
            modelConfig: {
              transducer: { encoder: join(model, 'encoder.int8.onnx'), decoder: join(model, 'decoder.int8.onnx'), joiner: join(model, 'joiner.int8.onnx') },
              tokens: join(model, 'tokens.txt'), numThreads: request.threads, provider: 'cpu', debug: 0,
            },
          });
          result = { ok: true }; break;
        }
        case 'start': begin(request.language); result = { ok: true }; break;
        case 'chunk': result = decode(request.audio); break;
        case 'finish': result = decode(request.audio, true); break;
        case 'transcribe': begin(request.language); result = decode(request.audio, true); break;
        default: throw new Error('unknown speech worker operation');
      }
      process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch {
      // Native exceptions can include configuration and transcripts. Report only the operation.
      process.stdout.write(`${JSON.stringify({ id: request?.id, error: 'speech: native decoder failed; reinstall the selected model and runtime' })}\n`);
    }
  }
}

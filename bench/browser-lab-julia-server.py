"""Opt-in CPU Julia benchmark endpoint. Launch through the owning process harness.

Requires the official Julia Python package, torch and transformers. ONNX requests
also require onnxruntime and an exported model.onnx directory. Supply an existing
temporary bearer-token file; this server never creates or prints credentials.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import inspect
import json
import math
import os
from pathlib import Path
import platform
import secrets
import stat
import threading
import time


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_token(path):
    with path.open('r', encoding='ascii') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('--token-file must be an existing regular file')
        if os.name != 'nt' and (stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()):
            raise ValueError('--token-file must be owned by this user with Unix mode 0600')
        token = stream.read(4097).strip()
    if not token or len(token) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise ValueError('--token-file must contain a nonempty ASCII bearer token without whitespace')
    return token


def peak_rss_kb():
    try:
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return value / 1024 if platform.system() == 'Darwin' else value
    except ImportError:
        return None


def finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError('JSON numbers must be finite')
    return value


def reject_constant(_text):
    raise ValueError('JSON numbers must be finite')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True, help='Local Julia checkpoint directory')
    parser.add_argument('--token-file', type=Path, required=True, help='Existing owned temporary token file')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18884)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--onnx-model-dir', type=Path, help='Optional directory containing model.onnx and external data')
    parser.add_argument('--revision', help='Optional checkpoint revision for provenance')
    args = parser.parse_args()
    if not 1 <= args.threads <= 8:
        parser.error('--threads must be between 1 and 8')
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if not args.model.is_dir() or not (args.model / 'model.safetensors').is_file():
        parser.error('--model must contain a local model.safetensors checkpoint')
    if args.onnx_model_dir is not None and not (args.onnx_model_dir / 'model.onnx').is_file():
        parser.error('--onnx-model-dir must contain model.onnx')
    try:
        token = read_token(args.token_file)
    except (OSError, ValueError, UnicodeError):
        parser.error('--token-file must be readable, nonempty ASCII, owned and mode 0600 on Unix')

    os.environ.update(OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads),
                      JULIA_CPU_THREADS=str(args.threads), HF_HUB_DISABLE_TELEMETRY='1')
    import torch
    import transformers
    from julia import load_model
    from julia.data import validate_row
    from julia.router.engine import FastEngine

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    engine = load_model(str(args.model), device='cpu', max_length=8192, head_length=1536,
                        batch_size=1, strict_encoding=True, marker_only_head=True)
    if not isinstance(engine, FastEngine):
        raise TypeError('Official load_model must return FastEngine')
    load_ms = (time.perf_counter() - started) * 1000
    weight = args.model / 'model.safetensors'
    metadata = dict(model='SupersonicLabs/Julia-1', revision=args.revision,
                    weightHash=digest(weight), weightBytes=weight.stat().st_size,
                    runtimeHash=digest(Path(inspect.getfile(FastEngine))),
                    serverHash=digest(Path(__file__)), torch=torch.__version__,
                    transformers=transformers.__version__, python=platform.python_version(),
                    platform=platform.system(), machine=platform.machine(), cpuThreads=args.threads,
                    interopThreads=1, loadMs=load_ms, markerOnlyHead=True, maxLength=8192,
                    strictEncoding=True, onnxConfigured=args.onnx_model_dir is not None)
    if args.onnx_model_dir is not None:
        metadata['onnxFiles'] = {str(path.relative_to(args.onnx_model_dir)).replace('\\', '/'): digest(path)
                                 for path in sorted(args.onnx_model_dir.rglob('*')) if path.is_file()}
    lock = threading.Lock()
    ort_session = None

    def onnx_logits(rows):
        nonlocal ort_session
        import onnxruntime as ort
        if ort_session is None:
            options = ort.SessionOptions()
            options.intra_op_num_threads = args.threads
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            ort_session = ort.InferenceSession(str(args.onnx_model_dir / 'model.onnx'),
                                              sess_options=options, providers=['CPUExecutionProvider'])
            metadata['onnxruntime'] = ort.__version__
        # Reuse the official strict encoder and tensor layout for the optional export.
        # One row at a time retains the torch batch_size=1 memory bound.
        result = []
        for row in rows:
            batch = {key: value.numpy() for key, value in engine._pack(engine._encode([row])).items()}
            scores = ort_session.run(['logits'], batch)[0][0]
            result.append(scores[:len(row['options'])].tolist())
        return result

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, body):
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            supplied = self.headers.get('Authorization', '').encode('utf-8')
            return secrets.compare_digest(supplied, ('Bearer ' + token).encode('ascii'))

        def do_GET(self):
            if not self.authorized():
                return self.respond(401, {'error': 'authorization'})
            if self.path != '/health':
                return self.respond(404, {'error': 'route'})
            self.respond(200, {'ready': True, 'metadata': metadata, 'peakRssKb': peak_rss_kb()})

        def do_POST(self):
            if not self.authorized():
                return self.respond(401, {'error': 'authorization'})
            if self.path != '/predict':
                return self.respond(404, {'error': 'route'})
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                return self.respond(400, {'error': 'Content-Length must be one decimal integer; transfer encoding is unsupported'})
            try:
                length = int(lengths[0])
            except ValueError:
                return self.respond(400, {'error': 'Invalid Content-Length integer'})
            if not 1 <= length <= 1048576:
                return self.respond(413, {'error': 'body size must be 1 to 1048576 bytes'})
            try:
                self.connection.settimeout(30)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Request body is shorter than Content-Length')
                body = json.loads(raw, parse_float=finite_float, parse_constant=reject_constant)
                if not isinstance(body, dict):
                    raise ValueError('body must be an object')
                rows = body.get('rows')
                if not isinstance(rows, list) or not 1 <= len(rows) <= 16:
                    raise ValueError('rows must have 1 to 16 requests')
                for index, row in enumerate(rows):
                    validate_row(row, index + 1)
                max_length = body.get('maxLength', 8192)
                backend = body.get('backend', 'torch')
                encoding_only = body.get('encodingOnly', False)
                if backend not in ('torch', 'onnx'):
                    raise ValueError('backend must be torch or onnx')
                if backend == 'onnx' and args.onnx_model_dir is None:
                    raise ValueError('onnx backend requires --onnx-model-dir')
                if type(max_length) is not int or max_length not in (1024, 2048, 4096, 8192):
                    raise ValueError('maxLength must be 1024, 2048, 4096 or 8192')
                if type(encoding_only) is not bool:
                    raise ValueError('encodingOnly must be boolean')
                with lock:
                    engine.max_length = max_length
                    engine.head_length = min(1536, max_length // 2)
                    at = time.perf_counter()
                    info = engine.encoding_info(rows)
                    encoding_ms = (time.perf_counter() - at) * 1000
                    inference_at = time.perf_counter()
                    logits = ([None] * len(rows) if encoding_only else
                              onnx_logits(rows) if backend == 'onnx' else engine.logits(rows))
                    inference_ms = (time.perf_counter() - inference_at) * 1000
                    if len(logits) != len(rows) or len(info) != len(rows):
                        raise RuntimeError('Runtime result count does not match requests')
                    results = []
                    for row, scores, audit in zip(rows, logits, info):
                        if scores is None:
                            results.append(dict(inputTokens=audit['tokens'], encoding=audit))
                            continue
                        if len(scores) != len(row['options']) or not all(math.isfinite(x) for x in scores):
                            raise FloatingPointError('Inference logits must be finite and match option count')
                        peak = max(scores)
                        weights = [math.exp(value - peak) for value in scores]
                        total = sum(weights)
                        results.append(dict(index=scores.index(peak), probabilities=[x / total for x in weights],
                                            logits=scores, elapsedMs=(time.perf_counter() - at) * 1000,
                                            inputTokens=audit['tokens'], encoding=audit))
                    response = dict(results=results, elapsedMs=(time.perf_counter() - at) * 1000,
                                    encodingMs=encoding_ms, inferenceMs=inference_ms,
                                    backend=backend, peakRssKb=peak_rss_kb())
                self.respond(200, response)
            except (ValueError, KeyError, TypeError, UnicodeError, RecursionError) as error:
                self.respond(422, {'error': str(error), 'strictEncoding': True})
            except TimeoutError:
                self.respond(408, {'error': 'request body timeout'})
            except Exception as error:
                self.respond(500, {'error': type(error).__name__})

    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print('JULIA_SERVER_READY ' + json.dumps(metadata), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()

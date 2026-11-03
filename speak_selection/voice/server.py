"""Kokoro voice server for speak-selection, one per Claude Code session.

HTTP over a Unix socket:
  GET  /status -> {"state": "downloading" | "loading" | "idle" | "speaking" | "failed", "error"?}
  POST /say    {"text", "voice", "speed"} -> 202, queued and spoken sentence by sentence
  POST /stop   -> 200, clears the queue and silences playback at once
Exits after --idle seconds without a request while idle.
"""
import argparse
import json
import os
import queue
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
PLAYER = shutil.which("pw-play") or shutil.which("paplay")

lock = threading.Lock()
kokoro = None
load_error = None
is_downloading = False
generation = 0  # bumped by /stop; work from an older generation is dropped
sentences: queue.Queue = queue.Queue()
clips: queue.Queue = queue.Queue()
busy = 0  # sentences queued, being made, or playing
player = None
last_request = time.monotonic()


def load(cache):
    global kokoro, load_error
    try:
        kokoro = open_kokoro(cache)
    except Exception as error:  # no network, disk full: say so instead of loading forever
        load_error = str(error)


def open_kokoro(cache):
    global is_downloading
    os.makedirs(cache, exist_ok=True)
    for name in FILES:
        path = os.path.join(cache, name)
        if not os.path.exists(path):
            is_downloading = True
            urllib.request.urlretrieve(f"{RELEASE}/{name}", path + ".part")
            os.replace(path + ".part", path)
    is_downloading = False
    from kokoro_onnx import Kokoro

    return Kokoro(*(os.path.join(cache, n) for n in FILES))


def make_clips(scratch):
    """Synthesizes queued sentences into WAV files while earlier ones play."""
    import soundfile

    global busy
    while True:
        gen, text, voice, speed = sentences.get()
        if gen != generation:
            continue
        try:
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        except Exception as error:  # a bad voice name or odd text must not kill the worker
            print(f"speak-selection: could not speak {text[:40]!r}: {error}", flush=True)
            with lock:
                busy -= 1
            continue
        path = os.path.join(scratch, f"{time.monotonic_ns()}.wav")
        soundfile.write(path, samples, rate)
        clips.put((gen, path))


def play_clips():
    global busy, player
    while True:
        gen, path = clips.get()
        if gen == generation:
            with lock:
                player = subprocess.Popen([PLAYER, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            player.wait()
            with lock:
                player = None
        os.unlink(path)
        with lock:
            busy -= 1


def stop():
    global generation, busy
    with lock:
        generation += 1
        drained = 0
        for q in (sentences, clips):
            while True:
                try:
                    item = q.get_nowait()
                except queue.Empty:
                    break
                drained += 1
                if q is clips:
                    os.unlink(item[1])
        busy -= drained
        if player is not None:
            player.terminate()


def say(text, voice, speed):
    global busy
    parts = [p for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p]
    with lock:
        busy += len(parts)
        gen = generation
    for part in parts:
        sentences.put((gen, part, voice, speed))


def state():
    if load_error is not None:
        return "failed"
    if kokoro is None:
        return "downloading" if is_downloading else "loading"
    return "speaking" if busy > 0 else "idle"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.touch()
        if self.path == "/status":
            self.reply(200, {"state": state(), "error": load_error})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        self.touch()
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/stop":
            stop()
            self.reply(200, {})
        elif self.path == "/say":
            try:
                ask = json.loads(body)
                say(str(ask["text"]), str(ask.get("voice", "af_heart")), float(ask.get("speed", 1.0)))
            except (ValueError, KeyError, TypeError) as error:
                self.reply(400, {"error": str(error)})
                return
            self.reply(202, {})
        else:
            self.reply(404, {"error": "not found"})

    def touch(self):
        global last_request
        last_request = time.monotonic()

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def address_string(self):
        return "unix"

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--idle", type=float, default=600)
    args = parser.parse_args()
    if PLAYER is None:
        raise SystemExit("speak-selection: neither pw-play nor paplay is installed")

    if os.path.exists(args.socket):
        os.unlink(args.socket)
    server = Server(args.socket, Handler)
    scratch = tempfile.mkdtemp(prefix="speak-selection-")

    def watch_idle():
        while True:
            time.sleep(5)
            if state() == "idle" and time.monotonic() - last_request > args.idle:
                server.shutdown()
                return

    threading.Thread(target=load, args=(args.cache,), daemon=True).start()
    threading.Thread(target=make_clips, args=(scratch,), daemon=True).start()
    threading.Thread(target=play_clips, daemon=True).start()
    threading.Thread(target=watch_idle, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        os.unlink(args.socket)
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()

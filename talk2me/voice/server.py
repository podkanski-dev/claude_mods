"""Kokoro voice server for talk2me, one per Claude Code session.

HTTP on a port of 127.0.0.1 it picks and prints as "TALK2ME_PORT <n>".
Every request must carry "Authorization: Bearer $TALK2ME_TOKEN".
  GET  /status -> {"state": "downloading" | "loading" | "idle" | "speaking" | "failed",
                   "isPlaying": bool (audio coming out right now), "error"?}
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
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "talk2me")
TOKEN = os.environ.get("TALK2ME_TOKEN", "")


def player_for(platform, which=shutil.which):
    """The command that plays a WAV file here, "winsound" on Windows, or None."""
    if platform == "win32":
        return "winsound"
    names = ("afplay",) if platform == "darwin" else ("pw-play", "paplay")
    for name in names:
        path = which(name)
        if path:
            return [path]
    return None


class WinsoundPlayer:
    """Plays a WAV with Windows' built-in winsound, shaped like a Popen."""

    def __init__(self, path):
        import soundfile
        import winsound

        self.winsound = winsound
        self.stopped = threading.Event()
        self.seconds = soundfile.info(path).duration
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)

    def wait(self):
        self.stopped.wait(self.seconds)

    def terminate(self):
        self.winsound.PlaySound(None, 0)
        self.stopped.set()


PLAYER = player_for(sys.platform)

lock = threading.Lock()
kokoro = None
load_error = None
failed_at = 0.0
is_downloading = False
generation = 0  # bumped by /stop; work from an older generation is dropped
sentences: queue.Queue = queue.Queue()
clips: queue.Queue = queue.Queue()
busy = 0  # sentences queued, being made, or playing
player = None
last_request = time.monotonic()


def load(cache):
    global kokoro, load_error, failed_at
    try:
        kokoro = open_kokoro(cache)
    except Exception as error:  # no network, disk full: say so, then exit so the next press retries
        failed_at = time.monotonic()
        load_error = str(error)


def open_kokoro(cache):
    global is_downloading
    os.makedirs(cache, exist_ok=True)
    for name in FILES:
        path = os.path.join(cache, name)
        if not os.path.exists(path):
            is_downloading = True
            socket.setdefaulttimeout(60)  # a stalled download fails instead of hanging
            urllib.request.urlretrieve(f"{RELEASE}/{name}", path + ".part")
            os.replace(path + ".part", path)
    is_downloading = False
    from kokoro_onnx import Kokoro

    return Kokoro(*(os.path.join(cache, n) for n in FILES))


def make_clips(scratch):
    """Synthesizes queued sentences into WAV files while earlier ones play."""
    global busy
    while True:
        gen, text, voice, speed = sentences.get()
        if gen != generation:
            with lock:
                busy -= 1
            continue
        try:
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        except Exception as error:  # a bad voice name or odd text must not kill the worker
            print(f"talk2me: could not speak {text[:40]!r}: {error}", flush=True)
            with lock:
                busy -= 1
            continue
        import soundfile

        path = os.path.join(scratch, f"{time.monotonic_ns()}.wav")
        soundfile.write(path, samples, rate)
        clips.put((gen, path))


def play_clips():
    global busy, player
    while True:
        gen, path = clips.get()
        if gen == generation:
            with lock:
                if PLAYER == "winsound":
                    player = WinsoundPlayer(path)
                else:
                    player = subprocess.Popen([*PLAYER, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    # Under the lock, so a /stop can't land between counting and queueing.
    with lock:
        busy += len(parts)
        for part in parts:
            sentences.put((generation, part, voice, speed))


def should_exit(now, idle):
    if load_error is not None:
        return now - failed_at > 10  # long enough for the mod to read the error
    return state() == "idle" and now - last_request > idle


def state():
    if load_error is not None:
        return "failed"
    if kokoro is None:
        return "downloading" if is_downloading else "loading"
    return "speaking" if busy > 0 else "idle"


class Handler(BaseHTTPRequestHandler):
    def is_allowed(self):
        given = self.headers.get("Authorization", "")
        if TOKEN and secrets.compare_digest(given, f"Bearer {TOKEN}"):
            return True
        self.reply(403, {"error": "forbidden"})
        return False

    def do_GET(self):
        if not self.is_allowed():
            return
        self.touch()
        if self.path == "/status":
            self.reply(200, {"state": state(), "isPlaying": player is not None, "error": load_error})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.is_allowed():
            return
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

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", default=CACHE)
    parser.add_argument("--idle", type=float, default=600)
    args = parser.parse_args()
    if PLAYER is None:
        raise SystemExit("talk2me: no audio player found (install pw-play or paplay)")
    if not TOKEN:
        raise SystemExit("talk2me: TALK2ME_TOKEN is not set")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    print(f"TALK2ME_PORT {server.server_address[1]}", flush=True)
    scratch = tempfile.mkdtemp(prefix="talk2me-")

    def watch_idle():
        while True:
            time.sleep(5)
            if should_exit(time.monotonic(), args.idle):
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
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()

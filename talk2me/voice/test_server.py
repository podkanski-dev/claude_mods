"""Self-check for server.py's queue bookkeeping, no Kokoro or audio needed.

Run: python3 -I talk2me/voice/test_server.py
"""
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402


def wait_for(check, seconds=2.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.01)
    return False


def test_stale_sentence_is_uncounted():
    # A /say that queued after a /stop leaves a sentence from an old
    # generation; dropping it must not leave the server "speaking" forever.
    server.kokoro = object()
    server.busy = 1
    server.sentences.put((server.generation - 1, "Old.", "af_heart", 1.0))
    threading.Thread(target=server.make_clips, args=(tempfile.mkdtemp(),), daemon=True).start()
    assert wait_for(lambda: server.busy == 0), f"busy stuck at {server.busy}"
    assert server.state() == "idle"


def test_failed_load_exits_soon_so_the_next_press_retries():
    server.load_error = "no network"
    server.failed_at = 100.0
    assert not server.should_exit(now=105.0, idle=600)
    assert server.should_exit(now=111.0, idle=600)
    server.load_error = None


def test_idle_exit():
    server.last_request = 0.0
    server.busy = 0
    assert not server.should_exit(now=500.0, idle=600)
    assert server.should_exit(now=601.0, idle=600)


def test_player_for_each_platform():
    found = {"pw-play": "/usr/bin/pw-play", "paplay": "/usr/bin/paplay", "afplay": "/usr/bin/afplay"}.get
    nothing = lambda name: None  # noqa: E731
    assert server.player_for("linux", found) == ["/usr/bin/pw-play"]
    assert server.player_for("linux", lambda n: "/usr/bin/paplay" if n == "paplay" else None) == ["/usr/bin/paplay"]
    assert server.player_for("darwin", found) == ["/usr/bin/afplay"]
    assert server.player_for("win32", nothing) == "winsound"
    assert server.player_for("linux", nothing) is None


def test_requests_without_the_token_are_refused():
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    server.TOKEN = "secret"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/status"
    try:
        urllib.request.urlopen(url)
        raise AssertionError("no token was accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 403
    ask = urllib.request.Request(url, headers={"Authorization": "Bearer secret"})
    assert urllib.request.urlopen(ask).status == 200
    httpd.shutdown()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok {name}")

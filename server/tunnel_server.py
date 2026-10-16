import asyncio
import re
import signal
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class TunnelHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        asyncio.run(self.do_ASYNC())

    def do_HEAD(self):
        asyncio.run(self.do_ASYNC())

    def do_POST(self):
        asyncio.run(self.do_ASYNC())

    async def do_ASYNC(self):
        """Run supported requests in a per-request event loop."""
        if self.command == "POST":
            if self.headers.get_all("X-Tunnel-Original-Method") != ["GET"]:
                await asyncio.to_thread(self.send_error, 501, "Unsupported method ('POST')")
                return
            lengths = self.headers.get_all("Content-Length", [])
            if ("Transfer-Encoding" in self.headers
                    or len(lengths) > 1
                    or (lengths and re.fullmatch(r"0+", lengths[0]) is None)):
                # Do not drain an untrusted body or reuse its connection.
                self.close_connection = True
                await asyncio.to_thread(self.send_error, 400, "Translated GET requires an empty body")
                return
            del self.headers["X-Tunnel-Original-Method"]
            self.command = "GET"
            # BaseHTTPRequestHandler logs requestline, not command.
            self.requestline = f"GET {self.path} {self.request_version}"
        if self.command == "GET":
            # Await the extension hook directly; do_GET would nest asyncio.run.
            await self.handle_GET()
        elif self.command == "HEAD":
            await asyncio.to_thread(super().do_HEAD)

    async def handle_GET(self):
        """Async extension hook shared by direct and restored GET requests."""
        # Keep stdlib path handling and bounded streaming copy, off the loop.
        await asyncio.to_thread(super().do_GET)


async def main():
    handler = partial(TunnelHandler, directory=sys.argv[1])
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    assert task is not None
    previous_handlers = {
        sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)
    }
    with ThreadingHTTPServer(("127.0.0.1", 8000), handler) as server:
        try:
            for sig in previous_handlers:
                loop.add_signal_handler(sig, task.cancel)
            serving = asyncio.create_task(asyncio.to_thread(server.serve_forever))
            try:
                # Shield also preserves queued startup: shutdown must not wait
                # for a serve_forever call that cancellation prevented running.
                await asyncio.shield(serving)
            finally:
                async def stop():
                    # shutdown must run in a different thread from serve_forever.
                    await asyncio.to_thread(server.shutdown)
                    await serving

                stopping = asyncio.create_task(stop())
                cancelled = False
                while not stopping.done():
                    try:
                        await asyncio.shield(stopping)
                    except asyncio.CancelledError:
                        # Repeated signals must not interrupt executor cleanup.
                        cancelled = True
                stopping.result()
                if cancelled:
                    raise asyncio.CancelledError
        finally:
            for sig, previous in previous_handlers.items():
                loop.remove_signal_handler(sig)
                signal.signal(sig, previous)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass

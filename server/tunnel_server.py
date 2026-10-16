import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class TunnelHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get_all("X-Tunnel-Original-Method") != ["GET"]:
            self.send_error(501, "Unsupported method ('POST')")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if ("Transfer-Encoding" in self.headers
                or len(lengths) > 1
                or (lengths and re.fullmatch(r"0+", lengths[0]) is None)):
            # Do not drain an untrusted body or reuse its connection.
            self.close_connection = True
            self.send_error(400, "Translated GET requires an empty body")
            return
        del self.headers["X-Tunnel-Original-Method"]
        self.command = "GET"
        # BaseHTTPRequestHandler logs requestline, not command.
        self.requestline = f"GET {self.path} {self.request_version}"
        self.do_GET()


if __name__ == "__main__":
    handler = partial(TunnelHandler, directory=sys.argv[1])
    with ThreadingHTTPServer(("127.0.0.1", 8000), handler) as server:
        server.serve_forever()

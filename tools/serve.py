#!/usr/bin/env python
"""Dev server for omr/ — http.server with caching disabled.

Chrome's heuristic cache (Last-Modified + no Cache-Control) serves stale ES
modules across edit-reload cycles; no-store makes every reload honest.
Usage: python omr/tools/serve.py [port]   (default 8975, serves omr/)
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8975
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler) as srv:
        print(f"omr dev server: http://127.0.0.1:{PORT}/ (no-store)")
        srv.serve_forever()

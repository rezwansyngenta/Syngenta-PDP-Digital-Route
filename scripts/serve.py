# Dev server with Cache-Control: no-store so browser always picks up fresh edits.
import http.server, socketserver, functools, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"serving on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()

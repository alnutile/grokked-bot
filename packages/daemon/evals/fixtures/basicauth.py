"""A page behind HTTP basic auth, for the eval suite (port 8001).
Chrome shows its own sign-in popup for these, outside the page."""
import base64
from http.server import BaseHTTPRequestHandler, HTTPServer

OK = 'Basic ' + base64.b64encode(b'apiuser:eval-b4sic-SECRET').decode()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Authorization') == OK:
            body = b'<!doctype html><meta charset="utf-8"><title>API docs</title><h1>Secret API docs: access granted</h1><p>Version 2.4.1</p>'
            self.send_response(200)
        else:
            body = b'<h1>401 Unauthorized</h1>'
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Basic realm="Eval API"')
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

HTTPServer(('0.0.0.0', 8001), H).serve_forever()

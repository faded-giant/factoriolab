"""Static server for the built app at /factoriolab/, falling back to index.html like GitHub Pages."""
import http.server, os, sys

ROOT = sys.argv[1]
PREFIX = '/factoriolab/'

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split('?', 1)[0]
        if not path.startswith(PREFIX):
            return os.path.join(ROOT, '__missing__')
        rel = path[len(PREFIX):]
        full = os.path.join(ROOT, rel)
        if rel and os.path.isfile(full):
            return full
        return os.path.join(ROOT, 'index.html')

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), Handler).serve_forever()

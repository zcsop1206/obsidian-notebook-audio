# Drives the built plugin (main.js) in headless Chromium with the mock obsidian module
# (test/mock-obsidian.js) and a fake mic. Run `npm test` (builds first), or
# `python test/run_recorder_test.py` after `npm run build`. Screenshots land in test/out/.
# Exits non-zero if any check fails.
#
# Chromium: Playwright's own download is used when present; otherwise NB_CHROMIUM or
# /opt/pw-browsers/chromium (the browser pre-installed in cloud sessions).
import json, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765))  # lets parallel checkouts run the tests at once
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=os.path.dirname(HERE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)

def launch(pw):
    args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
    exe = os.environ.get('NB_CHROMIUM')
    if not exe:
        try:
            return pw.chromium.launch(args=args)
        except Exception as e:
            if os.path.exists('/opt/pw-browsers/chromium'):
                exe = '/opt/pw-browsers/chromium'
            else:
                raise
    return pw.chromium.launch(executable_path=exe, args=args)

def dump_fs(page):
    return page.evaluate("() => [...fs.entries()].map(([k, v]) => [k, v.length, typeof v])")

# Decodes the bytes written for `path` with an OfflineAudioContext; a segment file is only good
# if it decodes to a positive duration.
DECODE_JS = """async (path) => {
  const bytes = fs.get(path);
  if (!bytes) return { ok: false, text: `${path}: missing` };
  const ac = new OfflineAudioContext(1, 1, 48000);
  try { const buf = await ac.decodeAudioData(bytes.slice().buffer); return { ok: buf.duration > 0, seconds: buf.duration, text: `${path}: ${bytes.length} bytes, decodes to ${buf.duration.toFixed(2)} s` }; }
  catch (e) { return { ok: false, text: `${path}: ${bytes.length} bytes, DECODE FAILED ${e}` }; }
}"""

def hide(page):
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }""")

def show(page):
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }""")

try:
    with sync_playwright() as pw:
        b = launch(pw)
        ctx = b.new_context(permissions=['microphone'], device_scale_factor=2)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.evaluate("async () => { window.p = await loadPlugin(); }")
        check('plugin loads with the mock', page.evaluate("() => !!window.p"))

        # Recorder checks (audio A/B/C from the spike, note links, the pill, the player) are added
        # by the issues that build each piece.

        print('notices:', page.evaluate("() => notices"))
        print('page errors:', errors)
        check('no page errors', not errors, errors)
        b.close()
finally:
    srv.terminate()

if failures:
    print(f'\n{len(failures)} check(s) FAILED: ' + '; '.join(failures))
    sys.exit(1)
print('\nAll checks passed.')

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

        check('plugin has the toggle-recording command', page.evaluate("() => !!commands['toggle-recording']"))

        def decode(path):
            r = page.evaluate(DECODE_JS, path)
            print('  ' + r['text'])
            return r

        def start(d):
            return page.evaluate("async (d) => p.recorder.start({ dir: d, bitrate: 96000, format: 'auto', log: true, version: 'test', platform: 'desktop' })", d)

        def snap():
            return page.evaluate("() => p.recorder.snapshot()")

        def read_meta(d):
            return json.loads(page.evaluate("(d) => fs.get(d + '/meta.json')", d))

        def segment_files(d):
            return sorted(page.evaluate("(d) => [...fs.keys()].filter(k => k.startsWith(d + '/segment-'))", d))

        def print_log(name, d):
            text = page.evaluate("(d) => fs.get(d + '/log.md') || ''", d)
            print(f'LOG {name}:\n' + text)
            return text

        # --- audio A: appendBinary present; background, killed track, resume, stop
        dirA = 'audio/test-a'
        check('audio A: start returns true', start(dirA) is True, snap())
        page.wait_for_timeout(5000)
        hide(page)
        page.wait_for_timeout(200)
        snapHidden = snap()
        page.wait_for_timeout(1300)
        page.evaluate("() => p.recorder.track().stop()")  # simulate iOS taking the mic away
        page.wait_for_timeout(1500)
        show(page)
        try:
            page.wait_for_function("() => p.recorder.snapshot().state === 'resumed'", timeout=3000)
        except Exception:
            pass
        snapBack = snap()
        page.wait_for_timeout(5000)
        metaStopA = page.evaluate("async () => { const m = await p.recorder.stop(); return m && { ended: m.ended, n: m.segments.length }; }")
        snapIdle = snap()
        print_log('A', dirA)
        print('  snapshots: hidden', snapHidden, '| back', snapBack, '| after stop', snapIdle)
        segsA = segment_files(dirA)
        decA = [decode(f) for f in segsA]
        metaA = read_meta(dirA)
        sa = metaA['segments']
        check('audio A: hide, killed mic and return produced two segments', len(segsA) == 2, segsA)
        check('audio A: both segments decode', bool(decA) and all(r['ok'] for r in decA))
        check('audio A: meta has the hide moment and the return',
              len(sa) == 2 and 'audioEndMs' in sa[0] and sa[0]['reason'] == 'start' and sa[1]['reason'] == 'returned'
              and sa[1]['startMs'] > sa[0]['audioEndMs'] and [x['file'] for x in sa] == [f.split('/')[-1] for f in segsA], sa)
        check('audio A: meta ended clean with stoppedMs, bytes and chunks',
              metaA.get('ended') == 'clean' and isinstance(metaA.get('stoppedMs'), (int, float)) and all(x.get('bytes', 0) > 0 and x.get('chunks', 0) > 0 for x in sa)
              and metaA['format'] == 1 and metaA['plugin'] == 'notebook-audio' and metaA['timesliceMs'] == 2000 and metaA['appendBinary'] is True
              and metaA['device']['platform'] == 'desktop' and metaStopA == {'ended': 'clean', 'n': 2}, {k: v for k, v in metaA.items() if k != 'device'})
        check('audio A: snapshot paused while hidden', snapHidden['state'] == 'paused' and snapHidden['dir'] == dirA, snapHidden)
        check('audio A: snapshot resumed on return with about 3 s lost',
              snapBack['state'] == 'resumed' and 2500 <= snapBack['lastLostMs'] <= 4000 and snapBack['lostMs'] == snapBack['lastLostMs'], snapBack)
        check('audio A: snapshot idle after stop', snapIdle['state'] == 'idle' and snapIdle['elapsedMs'] == 0 and snapIdle['dir'] == '', snapIdle)

        # --- audio C: what the iPad does. Hidden, then back with the mic live and the recorder
        # saying "recording" but delivering nothing. Then the same stall while visible (watchdog).
        dirC = 'audio/test-c'
        start(dirC)
        page.wait_for_timeout(4500)
        hide(page)
        page.evaluate("() => { p.recorder.rec.ondataavailable = null; }")
        page.wait_for_timeout(2000)
        show(page)
        page.wait_for_timeout(4500)
        page.evaluate("() => { p.recorder.rec.ondataavailable = null; }")  # stall while visible
        page.wait_for_timeout(9000)
        page.evaluate("async () => { await p.recorder.stop(); }")
        logC = print_log('C', dirC)
        segsC = segment_files(dirC)
        decC = [decode(f) for f in segsC]
        metaC = read_meta(dirC)
        sc = metaC['segments']
        ok_meta = ([x['file'] for x in sc] == [f.split('/')[-1] for f in segsC] and len(sc) == 3 and sc[0]['startMs'] < 1000
                   and all('audioEndMs' in x for x in sc) and sc[1]['startMs'] > sc[0]['audioEndMs'] and sc[2]['startMs'] > sc[1]['audioEndMs'])
        check('audio C: return and watchdog each started a new segment, with start times in meta.json',
              ok_meta and len(segsC) == 3 and 'back after' in logC and 'no audio for' in logC and all(r['ok'] for r in decC), sc)
        check('audio C: segment reasons are start, returned, watchdog', [x['reason'] for x in sc] == ['start', 'returned', 'watchdog'], [x['reason'] for x in sc])

        # --- audio B: no appendBinary, then a crash mid-recording, then recovery by a new instance
        dirB = 'audio/test-b'
        page.evaluate("() => { window.savedAppendBinary = adapter.appendBinary; delete adapter.appendBinary; }")
        start(dirB)
        page.wait_for_timeout(7000)
        page.evaluate("""async () => {
          const r = p.recorder; r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); r.stream.getTracks().forEach(t => t.stop());
          await r.q.idle();
          // A crash kills every timer too; without this the dead instance's watchdog would reopen the mic.
          const top = setTimeout(() => {}, 0); for (let i = 0; i <= top; i++) { clearTimeout(i); clearInterval(i); } }""")
        partsBefore = [k for k, *_ in dump_fs(page) if k.startswith(dirB + '/parts-')]
        page.evaluate("async () => { window.p2 = await loadPlugin(); }")
        recB = page.evaluate("async (d) => { const m = await p2.recoverRecording(adapter, d); return m && { ended: m.ended, n: m.segments.length }; }", dirB)
        after = [k for k, *_ in dump_fs(page) if k.startswith(dirB)]
        logB = print_log('B', dirB)
        decB = [decode(f) for f in after if '/segment-' in f]
        metaB = read_meta(dirB)
        sizeB = page.evaluate("(d) => { const f = fs.get(d + '/segment-01.' + JSON.parse(fs.get(d + '/meta.json')).ext); return f ? f.length : -1; }", dirB)
        check('audio B: parts were written while appendBinary was missing', len(partsBefore) >= 3 and metaB['appendBinary'] is False, partsBefore)
        check('audio B: recovery merged the parts into a file that decodes',
              bool(decB) and all(r['ok'] for r in decB) and not any('/parts-' in k for k in after), after)
        check('audio B: meta marked recovered with bytes from the file size',
              recB == {'ended': 'recovered', 'n': 1} and metaB.get('ended') == 'recovered' and metaB['segments'][0].get('bytes') == sizeB and sizeB > 0, (recB, metaB['segments'], sizeB))
        check("audio B: log.md has a 'recovered' line", 'recovered after unclean exit' in logB and 'rebuilt from parts' in logB)
        check('audio B: recovering again returns null', page.evaluate("async (d) => (await p2.recoverRecording(adapter, d)) === null", dirB) is True)
        check('audio B: a folder without meta.json returns null', page.evaluate("async () => (await p2.recoverRecording(adapter, 'audio/nothing-here')) === null") is True)
        page.evaluate("() => { adapter.appendBinary = window.savedAppendBinary; }")

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

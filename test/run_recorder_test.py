# Drives the built plugin (main.js) in headless Chromium with the mock obsidian module
# (test/mock-obsidian.js) and a fake mic. Run `npm test` (builds first), or
# `python test/run_recorder_test.py` after `npm run build`. Screenshots land in test/out/.
# Exits non-zero if any check fails.
#
# Chromium: Playwright's own download is used when present; otherwise NB_CHROMIUM or
# /opt/pw-browsers/chromium (the browser pre-installed in cloud sessions).
import json, os, re, subprocess, sys, time, urllib.parse
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

        # --- wiring (#3) and settings (#6): the command, folders next to the note, note links,
        # note-less recordings, recovery on launch, the settings tab. Driven through the newest
        # plugin instance, `pc` (the last one loaded registered the command).
        # The recorder crashed in audio B still listens for visibilitychange (a real crash would
        # have taken its listeners with it); drop that so hide/show below don't wake it.
        page.evaluate("() => { window.pc = window.p2; document.removeEventListener('visibilitychange', p.recorder.onVisibility); }")
        LECTURE = 'Notes/Physics/Lecture 3.md'
        LDIR = 'Notes/Physics/Lecture 3/audio'
        STAMP = r'\d{4}-\d{2}-\d{2} \d{2}-\d{2}(-\d{2})?'
        EMBED = r'!\[segment \d+, \d{2}:\d{2}:\d{2}, \d+:\d{2}\]\('

        def toggle():
            page.evaluate("async () => { await commands['toggle-recording'].callback(); }")

        def record(ms):
            toggle()
            page.wait_for_timeout(ms)
            toggle()

        def note_text(path):
            return page.evaluate("(p) => fs.get(p) || ''", path)

        def subdirs(parent):
            return sorted(page.evaluate("(d) => [...dirs].filter(k => k.startsWith(d + '/') && !k.slice(d.length + 1).includes('/'))", parent))

        def files_in(d):
            return sorted(page.evaluate("(d) => [...fs.keys()].filter(k => k.startsWith(d + '/') && !k.slice(d.length + 1).includes('/')).map(k => k.slice(d.length + 1))", d))

        def open_note(path):
            page.evaluate("async (p) => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath(p)); }", path)

        def active_file():
            return page.evaluate("() => { const f = app.workspace.getActiveFile(); return f && f.path; }")

        def pointer():
            return page.evaluate("() => (window.pluginData && pluginData.active) || null")

        # 1. next to the note, with a hide and a killed mic in the middle
        page.evaluate("async () => { dirs.add('Notes'); dirs.add('Notes/Physics'); await app.vault.create('Notes/Physics/Lecture 3.md', 'First line of notes\\nSecond line\\n'); }")
        open_note(LECTURE)
        page.evaluate("() => { const e = app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor; e.setCursor({ line: e.lastLine(), ch: e.getLine(e.lastLine()).length }); }")
        toggle()
        ptr1 = pointer()
        page.wait_for_timeout(3000)
        hide(page)
        page.wait_for_timeout(1500)
        page.evaluate("() => pc.recorder.track().stop()")
        page.wait_for_timeout(1000)
        show(page)
        page.wait_for_timeout(3000)
        toggle()
        folders1 = subdirs(LDIR)
        d1 = folders1[0] if len(folders1) == 1 else ''
        files1 = files_in(d1) if d1 else []
        meta1 = read_meta(d1) if 'meta.json' in files1 else {}
        text1 = note_text(LECTURE)
        print('NOTE after wiring 1:\n' + text1)
        tail1 = text1.rstrip('\n').split('\n')[-3:]
        check('wiring 1: one recording folder next to the note, named by the stamp',
              len(folders1) == 1 and bool(re.fullmatch(STAMP, d1.split('/')[-1])), folders1)
        check('wiring 1: meta.json and two segments, no log.md, meta.note is the note',
              files1 == ['meta.json', 'segment-01.m4a', 'segment-02.m4a'] and meta1.get('note') == LECTURE and meta1.get('ended') == 'clean', (files1, meta1.get('note')))
        check('wiring 1: the note ends with the header line and two embeds',
              text1.startswith('First line of notes\nSecond line\n\nRecording ')
              and bool(re.fullmatch(r'Recording \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\d+:\d{2} in 2 segments, 0:0\d lost while Obsidian was in the background\)', tail1[0]))
              and all(re.fullmatch(EMBED + r'Lecture%203/audio/[^)\s]+/segment-0\d\.m4a\)', l) for l in tail1[1:]), tail1)
        check('wiring 1: no wikilinks in the note', '[[' not in text1)
        check('wiring 1: pointer set while recording, cleared after',
              bool(ptr1) and ptr1.get('dir') == d1 and ptr1.get('notePath') == LECTURE and bool(ptr1.get('started')) and pointer() is None, (ptr1, pointer()))

        # 2. at the cursor, mid-line
        page.evaluate("() => app.workspace.getActiveViewOfType(obsidian.MarkdownView).editor.setCursor({ line: 0, ch: 3 })")
        record(3000)
        text2 = note_text(LECTURE)
        print('NOTE after wiring 2:\n' + text2)
        check('wiring 2: inserted at the cursor after a line break, the rest of the line follows',
              bool(re.match(r'Fir\n\nRecording [^\n]+\n' + EMBED + r'Lecture%203/audio/[^)\s]+/segment-01\.m4a\)\nst line of notes\n', text2)), text2[:200])
        check('wiring 2: the earlier block is intact', text2.endswith(text1[3:]) and len(subdirs(LDIR)) == 2)

        # 3. two recordings in the same minute
        sec = page.evaluate("() => new Date().getSeconds()")
        if sec > 45:
            page.wait_for_timeout((61 - sec) * 1000)
        before3 = set(subdirs(LDIR))
        record(3000)
        record(3000)
        new3 = sorted(set(subdirs(LDIR)) - before3)
        names3 = [d.split('/')[-1] for d in new3]
        check('wiring 3: two recordings in one minute get two folders',
              len(names3) == 2 and all(re.fullmatch(STAMP, n) for n in names3)
              and (bool(re.fullmatch(r'.* \d{2}-\d{2}-\d{2}', names3[1])) or names3[0][:16] != names3[1][:16]), names3)

        # 4. no note open
        page.evaluate("async () => { await app.workspace.activeLeaf.detach(); }")
        no_active = active_file()
        before4 = set(subdirs('audio'))
        record(3000)
        new4 = sorted(set(subdirs('audio')) - before4)
        d4 = new4[0] if len(new4) == 1 else ''
        stamp4 = d4.split('/')[-1]
        note4 = f'audio/Recording {stamp4}.md'
        text4 = note_text(note4)
        print('NOTE after wiring 4 (' + note4 + '):\n' + text4)
        check('wiring 4: no active file before', no_active is None, no_active)
        check('wiring 4: the recording goes to audio/<stamp>/',
              bool(re.fullmatch(STAMP, stamp4)) and files_in(d4) == ['meta.json', 'segment-01.m4a'] and read_meta(d4).get('note') == note4, (new4, files_in(d4) if d4 else None))
        check('wiring 4: the note was created and opened', active_file() == note4, active_file())
        check('wiring 4: the note has its title, the header and an embed relative to audio/',
              text4.startswith('# Recording ') and bool(re.search(r'\n\nRecording [^\n]+\n' + EMBED + re.escape(urllib.parse.quote(stamp4)) + r'/segment-01\.m4a\)\n$', text4)), text4)

        # 5. recovery on launch after a crash
        open_note(LECTURE)
        before5 = set(subdirs(LDIR))
        text_before5 = note_text(LECTURE)
        toggle()
        page.wait_for_timeout(5000)
        page.evaluate("""async () => {
          const r = pc.recorder; r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); r.stream.getTracks().forEach(t => t.stop());
          await r.q.idle();
          const top = setTimeout(() => {}, 0); for (let i = 0; i <= top; i++) { clearTimeout(i); clearInterval(i); }
          document.removeEventListener('visibilitychange', r.onVisibility); }""")
        ptr5 = pointer()
        open_note(note4)  # another note is active when Obsidian comes back
        page.evaluate("async () => { window.p3 = await loadPlugin(); window.pc = window.p3; }")
        try:
            page.wait_for_function("() => !(window.pluginData && pluginData.active)", timeout=15000)
        except Exception:
            pass
        page.wait_for_timeout(300)
        new5 = sorted(set(subdirs(LDIR)) - before5)
        d5 = new5[0] if len(new5) == 1 else ''
        meta5 = read_meta(d5) if d5 else {}
        text5 = note_text(LECTURE)
        added5 = text5[len(text_before5):]
        print('NOTE after wiring 5 (added):\n' + added5)
        notice5 = page.evaluate("() => { const el = noticeEls.find(e => e.textContent.includes('Recovered')); return el && { text: el.textContent, button: !!el.querySelector('button.notebook-audio-notice-button') }; }")
        print('  recovery notice:', notice5)
        check('wiring 5: the pointer was left behind by the crash, and recovery cleared it',
              bool(ptr5) and ptr5.get('dir') == d5 and pointer() is None, (ptr5, pointer()))
        check('wiring 5: meta.json marked recovered', meta5.get('ended') == 'recovered' and len(meta5.get('segments', [])) == 1, meta5.get('ended'))
        check('wiring 5: links appended to the note',
              text5.startswith(text_before5) and bool(re.fullmatch(r'\nRecording \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\d+:\d{2}\)\n' + EMBED + r'Lecture%203/audio/[^)\s]+/segment-01\.m4a\)\n', added5)), added5)
        check('wiring 5: a notice says Recovered, with an Open note button', bool(notice5) and notice5['button'] and 'Recovered an interrupted recording' in notice5['text'], notice5)
        page.evaluate("() => noticeEls.find(e => e.textContent.includes('Recovered')).querySelector('button').click()")
        page.wait_for_timeout(300)
        check('wiring 5: the button opens the note', active_file() == LECTURE, active_file())

        # 6. settings tab
        s6 = page.evaluate("""() => {
          const tab = pc.settingTabs[0]; tab.display(); const el = tab.containerEl, t = el.textContent;
          const sel = el.querySelectorAll('select'), items = [...el.querySelectorAll('.setting-item')];
          return {
            names: items.map(s => s.dataset.name),
            privacy: t.includes('.gitignore') && t.includes('**/audio/') && t.includes('private/') && t.includes('never publishes'),
            runningNote: items[0].textContent.includes('never affects a recording in progress'),
            bitrate: sel[0].value, bitrates: [...sel[0].options].map(o => o.value),
            format: sel[1].value, formats: [...sel[1].options].map(o => o.value),
            folder: el.querySelector('input[type=text]').value, log: el.querySelector('input[type=checkbox]').checked,
          }; }""")
        print('  settings tab:', s6)
        check('wiring 6: the settings tab shows the privacy note and four settings with their defaults',
              s6['privacy'] and s6['runningNote'] and len(s6['names']) == 4 and s6['bitrate'] == '96000'
              and s6['bitrates'] == ['48000', '64000', '96000', '128000', '192000'] and s6['format'] == 'auto'
              and s6['formats'] == ['auto', 'audio/mp4', 'audio/webm;codecs=opus'] and s6['folder'] == 'audio' and s6['log'] is False, s6)
        page.evaluate("""() => { const i = pc.settingTabs[0].containerEl.querySelector('input[type=text]'); i.value = ' /private//rec/ '; i.dispatchEvent(new Event('input')); }""")
        folder6 = page.evaluate("() => pluginData.settings.folder")
        page.evaluate("""() => { const i = pc.settingTabs[0].containerEl.querySelector('input[type=text]'); i.value = 'audio'; i.dispatchEvent(new Event('input')); }""")
        check('wiring 6: the folder setting is normalised', folder6 == 'private/rec', folder6)
        page.evaluate("() => { const s = pc.settingTabs[0].containerEl.querySelector('select'); s.value = '64000'; s.dispatchEvent(new Event('change')); }")
        stored6 = page.evaluate("() => pluginData.settings.bitrate")
        before6 = set(subdirs(LDIR))
        record(3000)
        new6 = sorted(set(subdirs(LDIR)) - before6)
        meta6 = read_meta(new6[0]) if len(new6) == 1 else {}
        page.evaluate("() => { const s = pc.settingTabs[0].containerEl.querySelector('select'); s.value = '96000'; s.dispatchEvent(new Event('change')); }")
        check('wiring 6: a bitrate change is saved and used by the next recording',
              stored6 == 64000 and meta6.get('bitrate') == 64000 and page.evaluate("() => pluginData.settings.bitrate") == 96000, (stored6, meta6.get('bitrate')))

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

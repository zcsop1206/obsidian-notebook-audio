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
        # --- player (#5): a recording with a gap, played as one timeline. Recorded by pc, the
        # newest plugin instance (the earlier ones had their recorders killed mid-recording above).
        page.evaluate("() => { if (!adapter.appendBinary && window.savedAppendBinary) adapter.appendBinary = window.savedAppendBinary; document.removeEventListener('visibilitychange', p.recorder.onVisibility); }")
        dirP = 'Notes/Lecture 3/audio/2026-09-27 14-03'
        okP = page.evaluate("""async (d) => pc.recorder.start({ dir: d, bitrate: 96000, format: 'auto', log: false, note: 'Notes/Lecture 3.md', version: 'test', platform: 'desktop' })""", dirP)
        page.wait_for_timeout(4000)
        hide(page)
        page.wait_for_timeout(1000)
        page.evaluate("() => pc.recorder.track().stop()")
        page.wait_for_timeout(1500)
        show(page)
        page.wait_for_timeout(4000)
        page.evaluate("async () => { await pc.recorder.stop(); }")
        metaP = read_meta(dirP)
        check('player: test recording has two segments', okP is True and len(metaP['segments']) == 2, metaP['segments'])
        seg_names = [x['file'] for x in metaP['segments']]
        # The note as the recorder writes it (by hand here), rendered as reading view does. Two
        # plugin instances are loaded, so two post-processors run: still one button.
        page.evaluate("""(files) => {
          const note = 'Recording 2026-09-27 14:03 (test)\\n' + files.map((f, i) => `![segment ${i + 1}, 14:03:12, 0:04](Lecture%203/audio/2026-09-27%2014-03/${f})`).join('\\n') + '\\n';
          fs.set('Notes/Lecture 3.md', note);
          window.playerBlock = renderMarkdown(note, 'Notes/Lecture 3.md');
        }""", seg_names)
        page.wait_for_timeout(500)
        nButtons = page.evaluate("() => playerBlock.querySelectorAll('.notebook-audio-open').length")
        check('player: one "Play as one timeline" button after the embeds', nButtons == 1, nButtons)
        page.evaluate("() => playerBlock.querySelector('.notebook-audio-open')?.click()")
        try:
            page.wait_for_function("() => app.workspace.getLeavesOfType('notebook-audio-player').length === 1", timeout=3000)
        except Exception:
            pass
        check('player: the button opens a player leaf', page.evaluate("() => app.workspace.getLeavesOfType('notebook-audio-player').length") == 1)
        page.evaluate("() => { window.pv = app.workspace.getLeavesOfType('notebook-audio-player')[0]?.view; window.playerLeaf = window.pv?.leaf; }")
        try:
            page.wait_for_function("() => window.pv && pv.timeline", timeout=8000)
        except Exception:
            pass
        tlP = page.evaluate("() => (window.pv && pv.timeline) || null")
        print('player timeline:', json.dumps(tlP))
        print('player: decoded durations (s)', page.evaluate("() => window.pv ? pv.audios.map(a => a.duration) : null"),
              '| meta (startMs, audioEndMs)', [(x['startMs'], x.get('audioEndMs')) for x in metaP['segments']])
        bar = page.evaluate("""() => {
          const q = s => [...pv.contentEl.querySelectorAll(s)];
          const text = s => pv.contentEl.querySelector(s)?.textContent;
          const pad = n => String(n).padStart(2, '0');
          const d = new Date(Date.parse(pv.meta.started));
          return { segs: q('.notebook-audio-seg').length, gaps: q('.notebook-audio-gap').length,
                   grows: q('.notebook-audio-bar > span').map(e => Number(e.style.flexGrow)),
                   gap: q('.notebook-audio-gap').map(e => Number(e.style.flexGrow)),
                   time: text('.notebook-audio-time'), clock: text('.notebook-audio-clock'), segnum: text('.notebook-audio-segnum'),
                   expectClock: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
                   title: pv.getDisplayText(), gapTitle: pv.contentEl.querySelector('.notebook-audio-gap')?.title };
        }""") if tlP else {}
        print('player bar:', bar)
        check('player: bar has 2 segments and 1 gap', bar.get('segs') == 2 and bar.get('gaps') == 1, bar)
        ratio = (bar['gap'][0] / sum(bar['grows'])) if bar.get('gap') and sum(bar['grows']) else -1
        check('player: gap width is proportional to the time lost',
              tlP is not None and abs(ratio - tlP['lostMs'] / tlP['totalMs']) <= 0.05, (ratio, tlP and tlP['lostMs'] / tlP['totalMs']))
        check('player: 1.5 to 4.5 s lost on the timeline', tlP is not None and 1500 <= tlP['lostMs'] <= 4500, tlP and tlP['lostMs'])

        def mmss_py(ms):
            sec = int(max(0, ms) // 1000)
            return f'{sec // 60}:{sec % 60:02d}'
        check('player: readout shows 0:00 / total, the start wall clock and segment 1 of 2',
              tlP is not None and bar.get('time') == f"0:00 / {mmss_py(tlP['totalMs'])}" and bar.get('clock') == bar.get('expectClock')
              and bar.get('segnum') == 'segment 1 of 2', bar)

        if tlP:
            page.evaluate("() => pv.play()")
            page.wait_for_timeout(1500)
            st = page.evaluate("() => ({ pos: pv.position, paused0: pv.audios[0].paused, seg: pv.currentSegment, head: pv.contentEl.querySelector('.notebook-audio-head').style.left })")
            check('player: play() advances the position with segment 1 playing', st['pos'] > 800 and st['paused0'] is False and st['seg'] == 0, st)
            page.evaluate("() => pv.seekTo(pv.timeline.totalMs - 400)")
            page.wait_for_timeout(300)
            st = page.evaluate("() => ({ seg: pv.currentSegment, pos: pv.position, playing: pv.audios.map(a => !a.paused) })")
            check('player: seeking near the end moves to segment 2, segment 1 stops', st['seg'] == 1 and not st['playing'][0], st)
            st = page.evaluate("""() => {
              const gap = pv.timeline.items.find(x => x.kind === 'gap'), seg2 = pv.timeline.items.find(x => x.kind === 'segment' && x.index === 1);
              pv.seekTo(gap.startMs + 100);
              const note = pv.contentEl.querySelector('.notebook-audio-gap-note');
              return { seg: pv.currentSegment, pos: pv.position, start2: seg2.startMs, note: note.classList.contains('is-visible') ? note.textContent : null };
            }""")
            check('player: seeking into the gap lands on segment 2 and says what was lost',
                  st['seg'] == 1 and abs(st['pos'] - st['start2']) <= 50 and bool(st['note']) and st['note'].endswith('lost here'), st)
            page.evaluate("() => pv.pause()")
            check('player: pause() pauses every audio element', page.evaluate("() => pv.audios.every(a => a.paused) && !pv.isPlaying"))
            # A click on the bar a quarter into segment 1 seeks there.
            box = page.evaluate("() => { const r = pv.contentEl.querySelector('.notebook-audio-seg').getBoundingClientRect(); return { x: r.left + r.width / 4, y: r.top + r.height / 2 }; }")
            page.mouse.click(box['x'], box['y'])
            st = page.evaluate("() => ({ pos: pv.position, seg: pv.currentSegment, d0: pv.timeline.items[0].durationMs, s0: pv.timeline.items[0].startMs })")
            check('player: a click on the bar seeks proportionally', st['seg'] == 0 and abs(st['pos'] - (st['s0'] + st['d0'] / 4)) < 0.05 * st['d0'], st)
            # Play across the gap: from 0.7 s before the end of segment 1 into segment 2.
            page.evaluate("() => { pv.seekTo(pv.timeline.items[0].endMs - 700); pv.play(); }")
            page.wait_for_timeout(1800)
            st = page.evaluate("""() => ({ seg: pv.currentSegment, pos: pv.position, start2: pv.timeline.items.find(x => x.kind === 'segment' && x.index === 1).startMs,
                                           playing: pv.audios.map(a => !a.paused), note: pv.contentEl.querySelector('.notebook-audio-gap-note').textContent })""")
            page.evaluate("() => pv.pause()")
            check('player: playback skips the gap into segment 2', st['seg'] == 1 and st['pos'] > st['start2'] and st['playing'] == [False, True] and st['note'].endswith('lost here'), st)
            page.evaluate("() => { pv.seekTo(pv.timeline.items[0].endMs * 0.6); }")
            clip = page.evaluate("() => { const r = document.getElementById('leaf').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: 260 }; }")
            page.screenshot(path=os.path.join(OUT, 'shot_player.png'), clip=clip)
            page.evaluate("() => document.body.classList.add('theme-dark')")
            page.screenshot(path=os.path.join(OUT, 'shot_player_dark.png'), clip=clip)
            page.evaluate("() => document.body.classList.remove('theme-dark')")

        # The command lists the note's recordings and reuses the open player.
        page.evaluate("async () => { await app.workspace.getLeaf(true).openFile(app.vault.getFile('Notes/Lecture 3.md')); }")
        page.evaluate("async () => { await commands['open-recording'].callback(); }")
        items = page.evaluate("() => [...document.querySelectorAll('.modal .suggestion-item')].map(e => e.textContent)")
        check('player: the command lists the recording', len(items) == 1 and 'Recording 2026-09-27 14:03' in items[0], items)
        if items:
            page.evaluate("() => document.querySelector('.modal .suggestion-item').click()")
            page.wait_for_timeout(300)
        st = page.evaluate("""() => { const l = app.workspace.activeLeaf; return { type: l && l.view && l.view.getViewType(), dir: l && l.view && l.view.dir,
                                      same: l === window.playerLeaf, n: app.workspace.getLeavesOfType('notebook-audio-player').length }; }""")
        check('player: choosing it activates the existing player on that recording', st == {'type': 'notebook-audio-player', 'dir': dirP, 'same': True, 'n': 1}, st)
        check('player: the view state keeps the folder (workspace reload)', page.evaluate("() => playerLeaf.getViewState().state.dir") == dirP)
        page.evaluate("async () => { fs.set('Notes/Empty.md', 'nothing recorded here\\n'); notices.length = 0; await app.workspace.getLeaf(true).openFile(app.vault.getFile('Notes/Empty.md')); await commands['open-recording'].callback(); }")
        check('player: a note without recordings gets a notice', any('No recordings' in n for n in page.evaluate("() => notices")), page.evaluate("() => notices"))
        # A missing segment file is marked in the bar and skipped: a copy of the recording without segment-01.
        dirM = 'Notes/Lecture 3/audio/2026-09-27 14-05'
        page.evaluate("""async ([d, m]) => { dirs.add(m); for (const f of ['meta.json', 'segment-02.m4a']) fs.set(m + '/' + f, fs.get(d + '/' + f)); await pc.player.open(m); }""", [dirP, dirM])
        try:
            page.wait_for_function("(m) => app.workspace.activeLeaf.view.dir === m && app.workspace.activeLeaf.view.timeline", arg=dirM, timeout=8000)
        except Exception:
            pass
        page.evaluate("() => { window.pm = app.workspace.activeLeaf.view; pm.play(); }")
        page.wait_for_timeout(700)
        st = page.evaluate("""() => ({ n: app.workspace.getLeavesOfType('notebook-audio-player').length, missing: pm.contentEl.querySelectorAll('.notebook-audio-seg.is-missing').length,
                                       seg: pm.currentSegment, playing: pm.audios.map(a => !a.paused), pos: pm.position, start2: pm.timeline.items.find(x => x.kind === 'segment' && x.index === 1).startMs })""")
        page.evaluate("() => pm.pause()")
        check('player: a missing segment file is marked and skipped', st['n'] == 2 and st['missing'] == 1 and st['seg'] == 1 and st['playing'] == [False, True] and st['pos'] > st['start2'], st)

        # --- status (#4), desktop: the status bar item of the newest instance, through a hide and a return
        REC = r'● \d+:\d{2} · \d+(\.\d)? (kB|MB) · \d+ segments?'

        def status(pg, js_el):
            return pg.evaluate("(sel) => { const e = eval(sel); const r = e.closest('.notebook-audio-pill') || e; return { text: e.textContent, state: r.dataset.state || '', visible: getComputedStyle(r).display !== 'none' && r.isConnected }; }", js_el)

        def st():
            return status(page, 'pc.ui.el')

        item = page.evaluate("() => { const e = pc.ui.el; return { inBar: e.parentElement.id === 'statusbar', cls: e.className, pill: !!document.querySelector('.notebook-audio-pill') }; }")
        st0 = st()
        check('status: a status bar item on desktop, clickable, hidden while idle, no pill',
              item['inBar'] and 'notebook-audio-status' in item['cls'] and 'mod-clickable' in item['cls'] and not item['pill']
              and not st0['visible'] and st0['text'] == '', (item, st0))
        toggle()
        page.wait_for_timeout(2500)
        stRec = st()
        hide(page)
        page.wait_for_timeout(300)
        stPaused = st()
        page.wait_for_timeout(2000)
        show(page)
        page.wait_for_timeout(1000)
        stResumed = st()
        page.wait_for_timeout(6000)
        stLost = st()
        page.locator('#statusbar').screenshot(path=os.path.join(OUT, 'shot_status_bar.png'))
        page.evaluate("() => pc.ui.el.click()")
        try:
            page.wait_for_function("() => pc.recorder.state === 'idle' && !(window.pluginData && pluginData.active)", timeout=10000)
        except Exception:
            pass
        stStopped = st()
        print('  status bar:', [x['text'] for x in (stRec, stPaused, stResumed, stLost)])
        check('status: recording shows elapsed, size and segments', stRec['visible'] and stRec['state'] == 'recording' and bool(re.fullmatch(REC, stRec['text'])), stRec)
        check('status: hidden shows "Paused: Obsidian was in the background"',
              stPaused['visible'] and stPaused['state'] == 'paused' and bool(re.fullmatch(r'Paused: Obsidian was in the background · \d+:\d{2}', stPaused['text'])), stPaused)
        check('status: the return shows "Resumed, 0:0N lost"',
              stResumed['state'] == 'resumed' and bool(re.fullmatch(r'Resumed, 0:0[1-4] lost while Obsidian was in the background · \d+ segments?', stResumed['text'])), stResumed)
        check('status: then the running state with the total lost time',
              stLost['state'] == 'recording' and bool(re.fullmatch(REC + r' · 0:0[1-4] lost', stLost['text'])) and '2 segments' in stLost['text'], stLost)
        check('status: a click stops the recording and the item hides', not stStopped['visible'] and stStopped['text'] == '' and page.evaluate("() => pc.recorder.state") == 'idle', stStopped)

        # A start that fails: the error for 5 s, then hidden.
        page.evaluate("() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); }")
        toggle()
        page.wait_for_timeout(300)
        stErr = st()
        page.wait_for_timeout(5200)
        stErrGone = st()
        page.evaluate("() => { delete navigator.mediaDevices.getUserMedia; }")
        check('status: a refused mic shows "Could not record: …" for 5 s, then hides',
              stErr['visible'] and stErr['state'] == 'error' and stErr['text'] == 'Could not record: microphone refused: NotAllowedError'
              and not stErrGone['visible'] and pointer() is None, (stErr, stErrGone))

        # --- status (#4), mobile: the floating pill, in a page where Platform says iPad
        mp = ctx.new_page()
        mp.set_viewport_size({'width': 1180, 'height': 820})
        mp.on('pageerror', lambda e: errors.append('mobile: ' + str(e)))
        mp.on('console', lambda m: m.type == 'error' and errors.append('mobile: ' + m.text))
        mp.goto(f'http://localhost:{port}/test/harness.html')
        mp.evaluate("""async () => {
          Object.assign(obsidian.Platform, { isMobile: true, isMobileApp: true, isIosApp: true, isTablet: true, isDesktop: false, isDesktopApp: false, isLinux: false });
          dirs.add('Notes'); await app.vault.create('Notes/iPad.md', '# Lecture on the iPad\\n\\nFirst line of notes.\\nSecond line.\\n');
          await app.vault.create('Notes/Other.md', 'Another note\\n');
          await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Notes/iPad.md'));
          window.p = await loadPlugin(); }""")

        def pill():
            return status(mp, 'p.ui.el')

        m0 = mp.evaluate("""() => { const all = document.querySelectorAll('.notebook-audio-pill'); const e = all[0];
          return { n: all.length, inBody: !!e && e.parentElement === document.body, textEl: !!e && p.ui.el.parentElement === e,
                   bar: document.querySelectorAll('#statusbar .notebook-audio-status').length }; }""")
        pi0 = pill()
        check('pill: one pill on mobile, on the body, no status bar item, hidden while idle',
              m0 == {'n': 1, 'inBody': True, 'textEl': True, 'bar': 0} and not pi0['visible'], (m0, pi0))
        mp.evaluate("async () => { await commands['toggle-recording'].callback(); }")
        mp.wait_for_timeout(2500)
        piRec = pill()
        box = mp.evaluate("""() => { const e = document.querySelector('.notebook-audio-pill'), r = e.getBoundingClientRect(), cs = getComputedStyle(e);
          return { cx: (r.left + r.right) / 2, w: innerWidth, bottom: innerHeight - r.bottom, h: r.height, pos: cs.position, pe: cs.pointerEvents, z: Number(cs.zIndex),
                   stop: getComputedStyle(e.querySelector('.notebook-audio-pill-stop')).display !== 'none' && e.querySelector('.notebook-audio-pill-stop').textContent }; }""")
        mp.screenshot(path=os.path.join(OUT, 'shot_pill_recording.png'), full_page=True)
        mp.evaluate("async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Notes/Other.md')); }")
        piSwitched = pill()
        print('  pill box:', box)
        check('pill: visible while recording, with the running text and a Stop label',
              piRec['visible'] and piRec['state'] == 'recording' and bool(re.fullmatch(REC[2:], piRec['text'])) and box['stop'] == 'Stop', (piRec, box))
        check('pill: fixed at the bottom centre above the toolbar, touch-sized, takes taps',
              box['pos'] == 'fixed' and abs(box['cx'] - box['w'] / 2) < 2 and 55 <= box['bottom'] <= 70 and box['h'] >= 44 and box['pe'] == 'auto' and box['z'] > 0, box)
        check('pill: stays while the user switches notes', piSwitched['visible'] and piSwitched['state'] == 'recording', piSwitched)
        hide(mp)
        mp.wait_for_timeout(300)
        piPaused = pill()
        mp.screenshot(path=os.path.join(OUT, 'shot_pill_paused.png'), full_page=True)
        mp.evaluate("() => document.body.classList.add('theme-dark')")
        mp.screenshot(path=os.path.join(OUT, 'shot_pill_paused_dark.png'), full_page=True)
        mp.evaluate("() => document.body.classList.remove('theme-dark')")
        mp.wait_for_timeout(1500)
        show(mp)
        mp.wait_for_timeout(1000)
        piResumed = pill()
        check('pill: paused while hidden', piPaused['visible'] and piPaused['state'] == 'paused' and bool(re.fullmatch(r'Paused: Obsidian was in the background · \d+:\d{2}', piPaused['text'])), piPaused)
        check('pill: resumed on return', piResumed['state'] == 'resumed' and bool(re.fullmatch(r'Resumed, 0:0[1-4] lost while Obsidian was in the background · \d+ segments?', piResumed['text'])), piResumed)
        mp.click('.notebook-audio-pill')
        try:
            mp.wait_for_function("() => p.recorder.state === 'idle' && !(window.pluginData && pluginData.active)", timeout=10000)
        except Exception:
            pass
        piStopped = pill()
        mdirs = mp.evaluate("() => [...dirs].filter(d => /^Notes\\/iPad\\/audio\\/[^/]+$/.test(d))")
        mmeta = json.loads(mp.evaluate("(d) => fs.get(d + '/meta.json') || '{}'", mdirs[0])) if len(mdirs) == 1 else {}
        check('pill: a tap stops the recording and the pill hides',
              mp.evaluate("() => p.recorder.state") == 'idle' and not piStopped['visible'] and mmeta.get('ended') == 'clean'
              and mmeta.get('device', {}).get('platform') == 'ios' and len(mmeta.get('segments', [])) == 2, (piStopped, mdirs, mmeta.get('ended')))
        mp.close()

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

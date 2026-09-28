/*
 * Settings and the plugin's saved data. Settings are read when a recording starts; changing one
 * never affects a recording in progress. See CONTEXT.md, "UI" and "Files".
 */
import { type App, normalizePath, type Plugin, PluginSettingTab, Setting } from 'obsidian';

export interface Settings {
  /** audioBitsPerSecond, e.g. 96000. */
  bitrate: number;
  /** Vault folder for recordings made with no note open. */
  folder: string;
  /** Write log.md into each recording's folder. */
  log: boolean;
  /** 'auto' (RecorderOptions.format) or a mime type. */
  format: 'auto' | string;
}

export const DEFAULT_SETTINGS: Settings = { bitrate: 96000, folder: 'audio', log: false, format: 'auto' };

/** The recording in progress, saved before the recorder starts and cleared after a clean stop.
 *  Left behind by a crash or force quit, it tells the next launch what to recover. */
export interface ActiveRecording {
  /** Vault path of the recording folder. */
  dir: string;
  /** Vault path of the note the links go into. */
  notePath: string;
  /** ISO UTC. */
  started: string;
}

/** What saveData stores. */
export interface PluginData {
  settings: Settings;
  active?: ActiveRecording;
}

const BITRATES = [48000, 64000, 96000, 128000, 192000];
const FORMATS: Record<string, string> = {
  auto: 'Automatic (AAC in .m4a where available)',
  'audio/mp4': 'AAC in .m4a (audio/mp4)',
  'audio/webm;codecs=opus': 'Opus in .webm (audio/webm;codecs=opus)',
};

/** A folder setting as stored: normalised, and the default when empty or the vault root. */
export function normalizeFolder(value: string): string {
  const v = normalizePath(value.trim());
  return v === '' || v === '/' ? DEFAULT_SETTINGS.folder : v;
}

/** Plugin data from loadData(), with defaults for anything missing or malformed. */
export function parsePluginData(raw: unknown): PluginData {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = o.settings && typeof o.settings === 'object' ? (o.settings as Record<string, unknown>) : {};
  const settings: Settings = {
    bitrate: typeof s.bitrate === 'number' && isFinite(s.bitrate) && s.bitrate > 0 ? s.bitrate : DEFAULT_SETTINGS.bitrate,
    folder: typeof s.folder === 'string' ? normalizeFolder(s.folder) : DEFAULT_SETTINGS.folder,
    log: typeof s.log === 'boolean' ? s.log : DEFAULT_SETTINGS.log,
    format: typeof s.format === 'string' && s.format ? s.format : DEFAULT_SETTINGS.format,
  };
  const a = o.active as Partial<ActiveRecording> | undefined;
  const data: PluginData = { settings };
  if (a && typeof a === 'object' && typeof a.dir === 'string' && a.dir && typeof a.notePath === 'string' && a.notePath) {
    data.active = { dir: a.dir, notePath: a.notePath, started: typeof a.started === 'string' ? a.started : '' };
  }
  return data;
}

/** The part of the plugin the tab needs. */
export interface SettingsHost extends Plugin {
  settings: Settings;
  saveSettings(): Promise<void>;
}

export class NotebookAudioSettingTab extends PluginSettingTab {
  private host: SettingsHost;

  constructor(app: App, plugin: SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    const save = () => this.host.saveSettings();
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'notebook-audio-privacy',
      text:
        'Recordings are private by default: audio is not meant for a public vault repo. Put the audio/ ' +
        'folders in the vault\'s .gitignore (for example a line **/audio/), or keep the notes you record ' +
        'under private/. This plugin never publishes or uploads anything; a clip leaves this device only ' +
        'through your own sync or git.',
    });

    new Setting(containerEl)
      .setName('Bitrate')
      .setDesc('Audio quality. 96 kbps is about 41 MB an hour. Read when a recording starts: a change never affects a recording in progress.')
      .addDropdown(d => {
        for (const b of BITRATES) d.addOption(String(b), `${b / 1000} kbps`);
        // A value set outside the list (by hand in data.json) still shows.
        if (!BITRATES.includes(s.bitrate)) d.addOption(String(s.bitrate), `${Math.round(s.bitrate / 1000)} kbps`);
        d.setValue(String(s.bitrate)).onChange(v => { s.bitrate = Number(v) || DEFAULT_SETTINGS.bitrate; void save(); });
      });

    new Setting(containerEl)
      .setName('Folder for recordings without a note')
      .setDesc('With no note open, a recording goes to <folder>/<date time>/ and a note "Recording <date time>" with its links is created here. Empty means audio.')
      .addText(t =>
        t.setPlaceholder(DEFAULT_SETTINGS.folder).setValue(s.folder).onChange(v => { s.folder = normalizeFolder(v); void save(); }),
      );

    new Setting(containerEl)
      .setName('Keep a log per recording')
      .setDesc('Write log.md into each recording\'s folder: what the microphone and the app did. Useful when reporting a problem.')
      .addToggle(t => t.setValue(s.log).onChange(v => { s.log = v; void save(); }));

    new Setting(containerEl)
      .setName('Preferred format')
      .setDesc('A format this device cannot record falls back to automatic.')
      .addDropdown(d => {
        d.addOptions(FORMATS);
        if (!(s.format in FORMATS)) d.addOption(s.format, s.format);
        d.setValue(s.format).onChange(v => { s.format = v; void save(); });
      });
  }
}

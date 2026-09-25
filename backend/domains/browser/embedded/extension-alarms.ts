/** Chrome alarms for the embedded companion. Electron accepts create() but does not deliver onAlarm here. The browser owns these schedules across worker suspension; stopping the browser retires them. They never grant browser action authority. */
export interface ExtensionAlarm { name: string; scheduledTime: number; periodInMinutes?: number }
interface Scheduled { alarm: ExtensionAlarm; timer: ReturnType<typeof setTimeout> }
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 2_147_483_647;
const MAX_ALARMS = 64;

export class ExtensionAlarms {
  private readonly scheduled = new Map<string, Scheduled>();
  constructor(private readonly deliver: (alarm: ExtensionAlarm) => void) {}

  call(method: string, args: unknown[]): unknown {
    const [first, second] = args;
    const name = typeof first === 'string' ? first : '';
    if (name.length > 128) throw new Error('Alarm name is too long.');
    if (method === 'alarms.get') return this.scheduled.get(name)?.alarm;
    if (method === 'alarms.getAll') return [...this.scheduled.values()].map(row => ({ ...row.alarm }));
    if (method === 'alarms.clear') return this.clear(name);
    if (method === 'alarms.clearAll') { this.close(); return true; }
    if (method !== 'alarms.create') throw new Error('Unsupported alarm operation.');
    const info = typeof first === 'string' ? second : first;
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Alarm info must be an object.');
    const { when, delayInMinutes, periodInMinutes } = info as Record<string, unknown>;
    for (const value of [when, delayInMinutes, periodInMinutes]) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error('Alarm times must be finite nonnegative numbers.');
      }
    }
    if (when !== undefined && delayInMinutes !== undefined) throw new Error('Specify when or delayInMinutes, not both.');
    if (periodInMinutes !== undefined && (periodInMinutes as number) < 0.5) throw new Error('Alarm period must be at least 0.5 minutes.');
    const delay = when !== undefined ? (when as number) - Date.now()
      : ((delayInMinutes ?? periodInMinutes ?? 0.5) as number) * 60_000;
    if (delay > MAX_DELAY_MS || (periodInMinutes as number ?? 0) * 60_000 > MAX_DELAY_MS) throw new Error('Alarm delay is too long.');
    if (!this.scheduled.has(name) && this.scheduled.size >= MAX_ALARMS) throw new Error('Too many alarms.');
    this.clear(name);
    this.arm({ name, scheduledTime: Date.now() + Math.max(MIN_DELAY_MS, delay),
      ...(periodInMinutes !== undefined ? { periodInMinutes: periodInMinutes as number } : {}) });
    return undefined;
  }

  close(): void { for (const name of this.scheduled.keys()) this.clear(name); }

  private clear(name: string): boolean {
    const row = this.scheduled.get(name);
    if (!row) return false;
    clearTimeout(row.timer);
    return this.scheduled.delete(name);
  }

  private arm(alarm: ExtensionAlarm): void {
    const row: Scheduled = { alarm, timer: setTimeout(() => {
      if (this.scheduled.get(alarm.name) !== row) return;
      this.scheduled.delete(alarm.name);
      if (alarm.periodInMinutes !== undefined) this.arm({ ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * 60_000 });
      this.deliver({ ...alarm });
    }, Math.max(0, alarm.scheduledTime - Date.now())) };
    row.timer.unref?.();
    this.scheduled.set(alarm.name, row);
  }
}

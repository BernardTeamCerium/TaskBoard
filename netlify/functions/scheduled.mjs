// Deadline reminders, the morning digest and the monthly report, every 15 minutes.
import { runScheduled } from '../dist/runtime.mjs';

export default async () => {
  const summary = await runScheduled();
  console.log('[taskboard] scheduled run', summary);
};

export const config = { schedule: '*/15 * * * *' };

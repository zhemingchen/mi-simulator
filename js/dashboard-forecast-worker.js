import {
  DEFAULT_FORWARD_PROJECTION_DAYS,
  runForwardProjection,
} from './dashboard-forecast.js';

self.onmessage = ({ data }) => {
  const {
    jobId,
    sim,
    horizonDays = DEFAULT_FORWARD_PROJECTION_DAYS,
  } = data ?? {};

  try {
    const result = runForwardProjection(sim, horizonDays, { trackRaw: true });
    self.postMessage({ type: 'ready', jobId, payload: result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId,
      message: err?.message ?? String(err),
    });
  }
};

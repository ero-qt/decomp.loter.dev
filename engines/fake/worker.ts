import { createFakeHandlers } from '#contract/fake';
import { serveEngine } from '#contract/serve';

serveEngine(self, createFakeHandlers());

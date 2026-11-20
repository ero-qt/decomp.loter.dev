import { serveEngine } from '../../contract/serve';
import { createNativeHandlers } from './handlers';

serveEngine(self, createNativeHandlers());

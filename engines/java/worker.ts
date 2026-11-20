import { serveEngine } from '../../contract/serve';
import { createJavaHandlers } from './handlers';

serveEngine(self, createJavaHandlers());

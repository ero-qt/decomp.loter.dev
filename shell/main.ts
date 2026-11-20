import { initialize } from '@codingame/monaco-vscode-api';
import { ISplashStorageService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/splash/browser/splash.service';
import configurationOverride from '@codingame/monaco-vscode-configuration-service-override';
import themeOverride from '@codingame/monaco-vscode-theme-service-override';
import workbenchOverride from '@codingame/monaco-vscode-workbench-service-override';
import { configurationDefaults, productConfiguration } from './config';
import './registration';

await initialize(
    {
        ...configurationOverride(),
        ...themeOverride(),
        ...workbenchOverride(),
        // drops the colors that the workbench saves for a splash screen because the page doesn't have a splash screen
        [ISplashStorageService.toString()]: { async saveWindowSplash() {} },
    },
    document.getElementById('workbench')!,
    {
        productConfiguration,
        configurationDefaults,
    },
);

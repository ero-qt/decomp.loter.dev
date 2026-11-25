import { StandaloneServices } from '@codingame/monaco-vscode-api/services';
import {
    type IHoverDelegateOptions,
    IInstantiationService,
    type IScopedHoverDelegate,
    Lazy,
    setHoverDelegateFactory,
    WorkbenchHoverDelegate,
} from './workbench';

/**
 * Sets hover delegates that create the workbench's hover delegate on their first hover, because the title bar's service
 * override creates the title bar before the workbench sets its hover delegates and the title bar's buttons then never
 * show a hover.
 */
export function deferHoverDelegates() {
    setHoverDelegateFactory((placement, instantHover) => {
        const delegate = new Lazy(() => {
            const instantiationService = StandaloneServices.get(IInstantiationService);

            return instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover }, {});
        });

        return {
            placement,
            get delay() {
                return delegate.value.delay;
            },
            showHover: (options: IHoverDelegateOptions, focus?: boolean) => delegate.value.showHover(options, focus),
            onDidHideHover: () => delegate.value.onDidHideHover(),
            dispose: () => delegate.rawValue?.dispose(),
        } satisfies IScopedHoverDelegate;
    });
}

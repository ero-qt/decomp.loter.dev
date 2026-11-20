import { EditorInputCapabilities, type IUntypedEditorInput, Verbosity } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor';
import { EditorInput } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput';
import { productConfiguration } from './config';

// shows in the About tab's hover
const aboutTitle = `About ${productConfiguration!.nameLong}`;

/**
 * The About tab's input, which shows the support note. Every About input matches the others, so a group keeps 1 About
 * tab.
 */
export class AboutInput extends EditorInput {
    static readonly typeId = 'decomp.aboutInput';

    override get typeId(): string {
        return AboutInput.typeId;
    }

    override get resource(): undefined {
        return undefined;
    }

    override get capabilities(): EditorInputCapabilities {
        return EditorInputCapabilities.Readonly;
    }

    override getName(): string {
        return 'About';
    }

    override getTitle(verbosity?: Verbosity): string {
        return verbosity === Verbosity.LONG ? aboutTitle : this.getName();
    }

    override matches(other: EditorInput | IUntypedEditorInput): boolean {
        return other instanceof AboutInput;
    }
}

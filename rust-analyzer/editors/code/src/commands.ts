import * as vscode from 'vscode';
import * as lc from 'vscode-languageclient';
import * as ra from './rust-analyzer-api';

import { Ctx, Cmd } from './ctx';
import { applySnippetWorkspaceEdit } from './snippets';
import { spawnSync } from 'child_process';
import { RunnableQuickPick, selectRunnable, createTask } from './run';
import { AstInspector } from './ast_inspector';
import { isRustDocument, sleep, isRustEditor } from './util';

export * from './ast_inspector';
export * from './run';

export function analyzerStatus(ctx: Ctx): Cmd {
    const tdcp = new class implements vscode.TextDocumentContentProvider {
        readonly uri = vscode.Uri.parse('rust-analyzer-status://status');
        readonly eventEmitter = new vscode.EventEmitter<vscode.Uri>();

        provideTextDocumentContent(_uri: vscode.Uri): vscode.ProviderResult<string> {
            if (!vscode.window.activeTextEditor) return '';

            return ctx.client.sendRequest(ra.analyzerStatus, null);
        }

        get onDidChange(): vscode.Event<vscode.Uri> {
            return this.eventEmitter.event;
        }
    }();

    let poller: NodeJS.Timer | undefined = undefined;

    ctx.pushCleanup(
        vscode.workspace.registerTextDocumentContentProvider(
            'rust-analyzer-status',
            tdcp,
        ),
    );

    ctx.pushCleanup({
        dispose() {
            if (poller !== undefined) {
                clearInterval(poller);
            }
        },
    });

    return async () => {
        if (poller === undefined) {
            poller = setInterval(() => tdcp.eventEmitter.fire(tdcp.uri), 1000);
        }
        const document = await vscode.workspace.openTextDocument(tdcp.uri);
        return vscode.window.showTextDocument(document, vscode.ViewColumn.Two, true);
    };
}

export function matchingBrace(ctx: Ctx): Cmd {
    return async () => {
        const editor = ctx.activeRustEditor;
        const client = ctx.client;
        if (!editor || !client) return;

        const response = await client.sendRequest(ra.matchingBrace, {
            textDocument: { uri: editor.document.uri.toString() },
            positions: editor.selections.map(s =>
                client.code2ProtocolConverter.asPosition(s.active),
            ),
        });
        editor.selections = editor.selections.map((sel, idx) => {
            const active = client.protocol2CodeConverter.asPosition(
                response[idx],
            );
            const anchor = sel.isEmpty ? active : sel.anchor;
            return new vscode.Selection(anchor, active);
        });
        editor.revealRange(editor.selection);
    };
}

export function joinLines(ctx: Ctx): Cmd {
    return async () => {
        const editor = ctx.activeRustEditor;
        const client = ctx.client;
        if (!editor || !client) return;

        const items: lc.TextEdit[] = await client.sendRequest(ra.joinLines, {
            ranges: editor.selections.map((it) => client.code2ProtocolConverter.asRange(it)),
            textDocument: { uri: editor.document.uri.toString() },
        });
        editor.edit((builder) => {
            client.protocol2CodeConverter.asTextEdits(items).forEach((edit) => {
                builder.replace(edit.range, edit.newText);
            });
        });
    };
}

export function onEnter(ctx: Ctx): Cmd {
    async function handleKeypress() {
        const editor = ctx.activeRustEditor;
        const client = ctx.client;

        if (!editor || !client) return false;

        const change = await client.sendRequest(ra.onEnter, {
            textDocument: { uri: editor.document.uri.toString() },
            position: client.code2ProtocolConverter.asPosition(
                editor.selection.active,
            ),
        }).catch(_error => {
            // client.logFailedRequest(OnEnterRequest.type, error);
            return null;
        });
        if (!change) return false;

        const workspaceEdit = client.protocol2CodeConverter.asWorkspaceEdit(change);
        await applySnippetWorkspaceEdit(workspaceEdit);
        return true;
    }

    return async () => {
        if (await handleKeypress()) return;

        await vscode.commands.executeCommand('default:type', { text: '\n' });
    };
}

export function parentModule(ctx: Ctx): Cmd {
    return async () => {
        const editor = ctx.activeRustEditor;
        const client = ctx.client;
        if (!editor || !client) return;

        const response = await client.sendRequest(ra.parentModule, {
            textDocument: { uri: editor.document.uri.toString() },
            position: client.code2ProtocolConverter.asPosition(
                editor.selection.active,
            ),
        });
        const loc = response[0];
        if (loc == null) return;

        const uri = client.protocol2CodeConverter.asUri(loc.uri);
        const range = client.protocol2CodeConverter.asRange(loc.range);

        const doc = await vscode.workspace.openTextDocument(uri);
        const e = await vscode.window.showTextDocument(doc);
        e.selection = new vscode.Selection(range.start, range.start);
        e.revealRange(range, vscode.TextEditorRevealType.InCenter);
    };
}

export function ssr(ctx: Ctx): Cmd {
    return async () => {
        const client = ctx.client;
        if (!client) return;

        const options: vscode.InputBoxOptions = {
            value: "() ==>> ()",
            prompt: "Enter request, for example 'Foo($a:expr) ==> Foo::new($a)' ",
            validateInput: async (x: string) => {
                try {
                    await client.sendRequest(ra.ssr, { query: x, parseOnly: true });
                } catch (e) {
                    return e.toString();
                }
                return null;
            }
        };
        const request = await vscode.window.showInputBox(options);
        if (!request) return;

        const edit = await client.sendRequest(ra.ssr, { query: request, parseOnly: false });

        await vscode.workspace.applyEdit(client.protocol2CodeConverter.asWorkspaceEdit(edit));
    };
}

export function serverVersion(ctx: Ctx): Cmd {
    return async () => {
        const { stdout } = spawnSync(ctx.serverPath, ["--version"], { encoding: "utf8" });
        const commitHash = stdout.slice(`rust-analyzer `.length).trim();
        const { releaseTag } = ctx.config.package;

        void vscode.window.showInformationMessage(
            `rust-analyzer version: ${releaseTag ?? "unreleased"} (${commitHash})`
        );
    };
}

export function toggleInlayHints(ctx: Ctx): Cmd {
    return async () => {
        await vscode
            .workspace
            .getConfiguration(`${ctx.config.rootSection}.inlayHints`)
            .update('enable', !ctx.config.inlayHints.enable, vscode.ConfigurationTarget.Workspace);
    };
}

export function run(ctx: Ctx): Cmd {
    let prevRunnable: RunnableQuickPick | undefined;

    return async () => {
        const item = await selectRunnable(ctx, prevRunnable);
        if (!item) return;

        item.detail = 'rerun';
        prevRunnable = item;
        const task = createTask(item.runnable);
        return await vscode.tasks.executeTask(task);
    };
}

// Opens the virtual file that will show the syntax tree
//
// The contents of the file come from the `TextDocumentContentProvider`
export function syntaxTree(ctx: Ctx): Cmd {
    const tdcp = new class implements vscode.TextDocumentContentProvider {
        readonly uri = vscode.Uri.parse('rust-analyzer://syntaxtree/tree.rast');
        readonly eventEmitter = new vscode.EventEmitter<vscode.Uri>();
        constructor() {
            vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this, ctx.subscriptions);
            vscode.window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor, this, ctx.subscriptions);
        }

        private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
            if (isRustDocument(event.document)) {
                // We need to order this after language server updates, but there's no API for that.
                // Hence, good old sleep().
                void sleep(10).then(() => this.eventEmitter.fire(this.uri));
            }
        }
        private onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined) {
            if (editor && isRustEditor(editor)) {
                this.eventEmitter.fire(this.uri);
            }
        }

        provideTextDocumentContent(uri: vscode.Uri, ct: vscode.CancellationToken): vscode.ProviderResult<string> {
            const rustEditor = ctx.activeRustEditor;
            if (!rustEditor) return '';

            // When the range based query is enabled we take the range of the selection
            const range = uri.query === 'range=true' && !rustEditor.selection.isEmpty
                ? ctx.client.code2ProtocolConverter.asRange(rustEditor.selection)
                : null;

            const params = { textDocument: { uri: rustEditor.document.uri.toString() }, range, };
            return ctx.client.sendRequest(ra.syntaxTree, params, ct);
        }

        get onDidChange(): vscode.Event<vscode.Uri> {
            return this.eventEmitter.event;
        }
    };

    void new AstInspector(ctx);

    ctx.pushCleanup(vscode.workspace.registerTextDocumentContentProvider('rust-analyzer', tdcp));
    ctx.pushCleanup(vscode.languages.setLanguageConfiguration("ra_syntax_tree", {
        brackets: [["[", ")"]],
    }));

    return async () => {
        const editor = vscode.window.activeTextEditor;
        const rangeEnabled = !!editor && !editor.selection.isEmpty;

        const uri = rangeEnabled
            ? vscode.Uri.parse(`${tdcp.uri.toString()}?range=true`)
            : tdcp.uri;

        const document = await vscode.workspace.openTextDocument(uri);

        tdcp.eventEmitter.fire(uri);

        void await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Two,
            preserveFocus: true
        });
    };
}


// Opens the virtual file that will show the syntax tree
//
// The contents of the file come from the `TextDocumentContentProvider`
export function expandMacro(ctx: Ctx): Cmd {
    function codeFormat(expanded: ra.ExpandedMacro): string {
        let result = `// Recursive expansion of ${expanded.name}! macro\n`;
        result += '// ' + '='.repeat(result.length - 3);
        result += '\n\n';
        result += expanded.expansion;

        return result;
    }

    const tdcp = new class implements vscode.TextDocumentContentProvider {
        uri = vscode.Uri.parse('rust-analyzer://expandMacro/[EXPANSION].rs');
        eventEmitter = new vscode.EventEmitter<vscode.Uri>();
        async provideTextDocumentContent(_uri: vscode.Uri): Promise<string> {
            const editor = vscode.window.activeTextEditor;
            const client = ctx.client;
            if (!editor || !client) return '';

            const position = editor.selection.active;

            const expanded = await client.sendRequest(ra.expandMacro, {
                textDocument: { uri: editor.document.uri.toString() },
                position,
            });

            if (expanded == null) return 'Not available';

            return codeFormat(expanded);
        }

        get onDidChange(): vscode.Event<vscode.Uri> {
            return this.eventEmitter.event;
        }
    }();

    ctx.pushCleanup(
        vscode.workspace.registerTextDocumentContentProvider(
            'rust-analyzer',
            tdcp,
        ),
    );

    return async () => {
        const document = await vscode.workspace.openTextDocument(tdcp.uri);
        tdcp.eventEmitter.fire(tdcp.uri);
        return vscode.window.showTextDocument(
            document,
            vscode.ViewColumn.Two,
            true,
        );
    };
}

export function collectGarbage(ctx: Ctx): Cmd {
    return async () => ctx.client.sendRequest(ra.collectGarbage, null);
}

export function showReferences(ctx: Ctx): Cmd {
    return (uri: string, position: lc.Position, locations: lc.Location[]) => {
        const client = ctx.client;
        if (client) {
            vscode.commands.executeCommand(
                'editor.action.showReferences',
                vscode.Uri.parse(uri),
                client.protocol2CodeConverter.asPosition(position),
                locations.map(client.protocol2CodeConverter.asLocation),
            );
        }
    };
}

export function applyActionGroup(_ctx: Ctx): Cmd {
    return async (actions: { label: string; edit: vscode.WorkspaceEdit }[]) => {
        const selectedAction = await vscode.window.showQuickPick(actions);
        if (!selectedAction) return;
        await applySnippetWorkspaceEdit(selectedAction.edit);
    };
}

export function applySnippetWorkspaceEditCommand(_ctx: Ctx): Cmd {
    return async (edit: vscode.WorkspaceEdit) => {
        await applySnippetWorkspaceEdit(edit);
    };
}

// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
/* eslint-disable @typescript-eslint/no-explicit-any */

import { InputBoxOptions } from '@theia/plugin';
import { interfaces } from '@theia/core/shared/inversify';
import { RPCProtocol } from '../../common/rpc-protocol';
import {
    QuickOpenExt,
    QuickOpenMain,
    MAIN_RPC_CONTEXT,
    TransferInputBox,
    TransferQuickPickItem,
    TransferQuickInput,
    TransferQuickInputButton,
    TransferQuickPickOptions
} from '../../common/plugin-api-rpc';
import {
    InputOptions,
    QuickInput,
    QuickInputButton,
    QuickInputButtonHandle,
    QuickInputService,
    QuickPickItem,
    codiconArray
} from '@theia/core/lib/browser';
import { DisposableCollection, Disposable } from '@theia/core/lib/common/disposable';
import { CancellationToken } from '@theia/core/lib/common/cancellation';
import { MonacoQuickInputService } from '@theia/monaco/lib/browser/monaco-quick-input-service';
import { QuickInputButtons } from '../../plugin/types-impl';
import * as monaco from '@theia/monaco-editor-core';
import { UriComponents } from '../../common/uri-components';
import { URI } from '@theia/core/shared/vscode-uri';
import { ThemeIcon } from '@theia/monaco-editor-core/esm/vs/base/common/themables';
import { isUriComponents } from '@theia/monaco-editor-core/esm/vs/base/common/uri';

export interface QuickInputSession {
    input: QuickInput;
    handlesToItems: Map<number, TransferQuickPickItem>;
}

interface IconPath {
    dark: URI,
    light?: URI
};

export class QuickOpenMainImpl implements QuickOpenMain, Disposable {

    private quickInputService: QuickInputService;
    private proxy: QuickOpenExt;
    private delegate: MonacoQuickInputService;
    private readonly items: Record<number, {
        resolve(items: QuickPickItem[]): void;
        reject(error: Error): void;
    }> = {};

    protected readonly toDispose = new DisposableCollection();

    constructor(rpc: RPCProtocol, container: interfaces.Container) {
        this.proxy = rpc.getProxy(MAIN_RPC_CONTEXT.QUICK_OPEN_EXT);
        this.delegate = container.get(MonacoQuickInputService);
        this.quickInputService = container.get(QuickInputService);
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    async $show(instance: number, options: TransferQuickPickOptions<TransferQuickPickItem>, token: CancellationToken): Promise<number | number[] | undefined> {
        const contents = new Promise<QuickPickItem[]>((resolve, reject) => {
            this.items[instance] = { resolve, reject };
        });

        const activeItem = await options.activeItem;
        const transformedOptions = {
            ...options,
            onDidFocus: (el: any) => {
                if (el) {
                    this.proxy.$onItemSelected(Number.parseInt((<QuickPickItem>el).id!));
                }
            },
            activeItem: activeItem ? this.toQuickPickItem(activeItem) : undefined
        };

        const result = await this.delegate.pick(contents, transformedOptions, token);

        if (Array.isArray(result)) {
            return result.map(({ id }) => Number.parseInt(id!));
        } else if (result) {
            return Number.parseInt(result.id!);
        }
        return undefined;
    }

    private normalizeIconPath(path: UriComponents | { light: UriComponents; dark: UriComponents } | ThemeIcon | undefined): {
        iconPath?: IconPath
        iconClasses?: string[]
    } {
        let iconClasses;
        if (ThemeIcon.isThemeIcon(path)) {
            const codicon = codiconArray(path.id);
            iconClasses = codicon;
        }
        let iconPath;
        if (isUriComponents(path)) {
            iconPath = { dark: URI.from(path) };
        } else if (path && 'dark' in path) {
            iconPath = { dark: URI.from(path.dark), light: URI.from(path.light) };
        }
        return {
            iconPath,
            iconClasses
        };
    }

    private toQuickPickItem(item: undefined): undefined;
    private toQuickPickItem(item: TransferQuickPickItem): QuickPickItem
    private toQuickPickItem(item: TransferQuickPickItem | undefined): QuickPickItem | undefined {
        if (!item) {
            return undefined;
        }
        return {
            ...this.normalizeIconPath(item.iconPath),
            type: 'item',
            id: item.handle.toString(),
            label: item.label,
            description: item.description,
            detail: item.detail,
            alwaysShow: item.alwaysShow,
            buttons: item.buttons ? this.convertToQuickInputButtons(item.buttons) : undefined
        };
    }

    $setItems(instance: number, items: TransferQuickPickItem[]): Promise<any> {
        if (this.items[instance]) {
            this.items[instance].resolve(items.map(item => this.toQuickPickItem(item)));
            delete this.items[instance];
        }
        return Promise.resolve();
    }

    $setError(instance: number, error: Error): Promise<void> {
        if (this.items[instance]) {
            this.items[instance].reject(error);
            delete this.items[instance];
        }
        return Promise.resolve();
    }

    $input(options: InputBoxOptions, validateInput: boolean, token: CancellationToken): Promise<string | undefined> {
        const inputOptions: InputOptions = Object.create(null);

        if (options) {
            inputOptions.title = options.title;
            inputOptions.password = options.password;
            inputOptions.placeHolder = options.placeHolder;
            inputOptions.valueSelection = options.valueSelection;
            inputOptions.prompt = options.prompt;
            inputOptions.value = options.value;
            inputOptions.ignoreFocusLost = options.ignoreFocusOut;
        }

        if (validateInput) {
            inputOptions.validateInput = (val: string) => this.proxy.$validateInput(val);
        }

        return this.quickInputService?.input(inputOptions, token);
    }

    async $showInputBox(options: TransferInputBox, validateInput: boolean): Promise<string | undefined> {
        return new Promise<string | undefined>((resolve, reject) => {
            const sessionId = options.id;
            const toDispose = new DisposableCollection();

            const inputBox = this.quickInputService?.createInputBox();
            inputBox.prompt = options.prompt;
            inputBox.placeholder = options.placeHolder;
            inputBox.value = options.value;
            if (options.busy) {
                inputBox.busy = options.busy;
            }
            if (options.enabled) {
                inputBox.enabled = options.enabled;
            }
            inputBox.ignoreFocusOut = options.ignoreFocusOut;
            inputBox.contextKey = options.contextKey;
            if (options.password) {
                inputBox.password = options.password;
            }
            inputBox.step = options.step;
            inputBox.title = options.title;
            inputBox.description = options.description;
            inputBox.totalSteps = options.totalSteps;
            inputBox.buttons = options.buttons ? this.convertToQuickInputButtons(options.buttons) : [];
            inputBox.validationMessage = options.validationMessage;
            if (validateInput) {
                options.validateInput = (val: string) => {
                    this.proxy.$validateInput(val);
                };
            }

            toDispose.push(inputBox.onDidAccept(() => {
                this.proxy.$acceptOnDidAccept(sessionId);
                resolve(inputBox.value);
            }));
            toDispose.push(inputBox.onDidChangeValue((value: string) => {
                this.proxy.$acceptDidChangeValue(sessionId, value);
                inputBox.validationMessage = options.validateInput(value);
            }));
            toDispose.push(inputBox.onDidTriggerButton((button: any) => {
                this.proxy.$acceptOnDidTriggerButton(sessionId, button);
            }));

            toDispose.push(inputBox.onDidHide(() => {
                if (toDispose.disposed) {
                    return;
                }
                this.proxy.$acceptOnDidHide(sessionId);
                toDispose.dispose();
                resolve(undefined);
            }));
            this.toDispose.push(toDispose);

            inputBox.show();
        });
    }

    private sessions = new Map<number, QuickInputSession>();

    $createOrUpdate(params: TransferQuickInput): Promise<void> {
        const sessionId = params.id;
        let session: QuickInputSession;
        const candidate = this.sessions.get(sessionId);
        if (!candidate) {
            if (params.type === 'quickPick') {
                const quickPick = this.quickInputService.createQuickPick();
                quickPick.onDidAccept(() => {
                    this.proxy.$acceptOnDidAccept(sessionId);
                });
                quickPick.onDidChangeActive((items: QuickPickItem[]) => {
                    this.proxy.$onDidChangeActive(sessionId, items.map(item => Number.parseInt(item.id!)));
                });
                quickPick.onDidChangeSelection((items: QuickPickItem[]) => {
                    this.proxy.$onDidChangeSelection(sessionId, items.map(item => Number.parseInt(item.id!)));
                });
                quickPick.onDidTriggerButton((button: QuickInputButtonHandle) => {
                    this.proxy.$acceptOnDidTriggerButton(sessionId, button);
                });
                quickPick.onDidTriggerItemButton(e => {
                    this.proxy.$onDidTriggerItemButton(sessionId, Number.parseInt(e.item.id!), (e.button as TransferQuickPickItem).handle);
                });
                quickPick.onDidChangeValue((value: string) => {
                    this.proxy.$acceptDidChangeValue(sessionId, value);
                });
                quickPick.onDidHide(() => {
                    this.proxy.$acceptOnDidHide(sessionId);
                });
                session = {
                    input: quickPick,
                    handlesToItems: new Map()
                };
            } else {
                const inputBox = this.quickInputService.createInputBox();
                inputBox.onDidAccept(() => {
                    this.proxy.$acceptOnDidAccept(sessionId);
                });
                inputBox.onDidTriggerButton((button: QuickInputButtonHandle) => {
                    this.proxy.$acceptOnDidTriggerButton(sessionId, button);
                });
                inputBox.onDidChangeValue((value: string) => {
                    this.proxy.$acceptDidChangeValue(sessionId, value);
                });
                inputBox.onDidHide(() => {
                    this.proxy.$acceptOnDidHide(sessionId);
                });
                session = {
                    input: inputBox,
                    handlesToItems: new Map()
                };
            }
            this.sessions.set(sessionId, session);
        } else {
            session = candidate;
        }
        if (session) {
            const { input, handlesToItems } = session;
            for (const param in params) {
                if (param === 'id' || param === 'type') {
                    continue;
                }
                if (param === 'visible') {
                    if (params.visible) {
                        input.show();
                    } else {
                        input.hide();
                    }
                } else if (param === 'items') {
                    handlesToItems.clear();
                    params[param].forEach((item: TransferQuickPickItem) => {
                        handlesToItems.set(item.handle, item);
                    });
                    (input as any)[param] = params[param];
                } else if (param === 'activeItems' || param === 'selectedItems') {
                    (input as any)[param] = params[param]
                        .filter((handle: number) => handlesToItems.has(handle))
                        .map((handle: number) => handlesToItems.get(handle));
                } else if (param === 'buttons') {
                    (input as any)[param] = params.buttons!.map(button => {
                        if (button.handle === -1) {
                            return this.quickInputService.backButton;
                        }
                        const { iconPath, tooltip, handle } = button;
                        if ('id' in iconPath) {
                            return {
                                iconClass: ThemeIcon.asClassName(iconPath),
                                tooltip,
                                handle
                            };
                        } else {
                            const monacoIconPath = (iconPath as unknown as { light: monaco.Uri, dark: monaco.Uri });
                            return {
                                iconPath: {
                                    dark: monaco.Uri.revive(monacoIconPath.dark),
                                    light: monacoIconPath.light && monaco.Uri.revive(monacoIconPath.light)
                                },
                                tooltip,
                                handle
                            };
                        }
                    });
                } else {
                    (input as any)[param] = params[param];
                }
            }
        }

        return Promise.resolve(undefined);
    }

    $hide(): void {
        this.delegate.hide();
    }

    $dispose(sessionId: number): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.input.dispose();
            this.sessions.delete(sessionId);
        }
        return Promise.resolve(undefined);
    }

    private convertToQuickInputButtons(buttons: readonly TransferQuickInputButton[]): QuickInputButton[] {
        return buttons.map((button, i) => ({
            ...this.normalizeIconPath(button.iconPath),
            tooltip: button.tooltip,
            handle: button === QuickInputButtons.Back ? -1 : i,
        } as QuickInputButton));
    }
}

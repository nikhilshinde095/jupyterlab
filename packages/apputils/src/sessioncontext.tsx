// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { PathExt, IChangedArgs } from '@jupyterlab/coreutils';

import { UUID } from '@lumino/coreutils';

import {
  Kernel,
  KernelMessage,
  KernelSpec,
  ServerConnection,
  Session
} from '@jupyterlab/services';

import { IterableOrArrayLike, each, find } from '@lumino/algorithm';

import { PromiseDelegate } from '@lumino/coreutils';

import { IDisposable, IObservableDisposable } from '@lumino/disposable';

import { ISignal, Signal } from '@lumino/signaling';

import { Widget } from '@lumino/widgets';

import * as React from 'react';

import { showDialog, Dialog } from './dialog';

/**
 * A context object to manage a widget's kernel session connection.
 *
 * #### Notes
 * The current session connection is `.session`, the current session's kernel
 * connection is `.session.kernel`. For convenience, we proxy several kernel
 * connection and and session connection signals up to the session context so
 * that you do not have to manage slots as sessions and kernels change. For
 * example, to act on whatever the current kernel's iopubMessage signal is
 * producing, connect to the session context `.iopubMessage` signal.
 *
 */
export interface ISessionContext extends IObservableDisposable {
  /**
   * The current session connection.
   */
  session: Session.ISessionConnection | null;

  /**
   * Initialize the session context.
   *
   * #### Notes
   * This includes starting up an initial kernel if needed.
   */
  initialize(): Promise<void>;

  /**
   * Whether the session context is ready.
   */
  readonly isReady: boolean;

  /**
   * A promise that is fulfilled when the session context is ready.
   */
  readonly ready: Promise<void>;

  /**
   * A signal emitted when the session connection changes.
   */
  readonly sessionChanged: ISignal<
    this,
    IChangedArgs<Session.ISessionConnection | null, 'session'>
  >;

  // Signals proxied from the session connection for convenience.

  /**
   * A signal emitted when the kernel changes, proxied from the session connection.
   */
  readonly kernelChanged: ISignal<
    this,
    IChangedArgs<Kernel.IKernelConnection | null, 'kernel'>
  >;

  /**
   * A signal emitted when the kernel status changes, proxied from the session connection.
   */
  readonly statusChanged: ISignal<this, Kernel.Status>;

  /**
   * A signal emitted when the kernel connection status changes, proxied from the session connection.
   */
  readonly connectionStatusChanged: ISignal<this, Kernel.ConnectionStatus>;

  /**
   * A signal emitted for a kernel messages, proxied from the session connection.
   */
  readonly iopubMessage: ISignal<this, KernelMessage.IMessage>;

  /**
   * A signal emitted for an unhandled kernel message, proxied from the session connection.
   */
  readonly unhandledMessage: ISignal<this, KernelMessage.IMessage>;

  /**
   * A signal emitted when a session property changes, proxied from the session connection.
   */
  readonly propertyChanged: ISignal<this, 'path' | 'name' | 'type'>;

  /**
   * The kernel preference for starting new kernels.
   */
  kernelPreference: ISessionContext.IKernelPreference;

  /**
   * The sensible display name for the kernel, or 'No Kernel'
   *
   * #### Notes
   * This is at this level since the underlying kernel connection does not
   * have access to the kernel spec manager.
   */
  readonly kernelDisplayName: string;

  /**
   * A sensible status to display
   *
   * #### Notes
   * This combines the status and connection status into a single status for the user.
   */
  readonly kernelDisplayStatus: ISessionContext.KernelDisplayStatus;

  /**
   * The session path.
   *
   * #### Notes
   * Typically `.session.path` should be used. This attribute is useful if
   * there is no current session.
   */
  readonly path: string;

  /**
   * The session type.
   *
   * #### Notes
   * Typically `.session.type` should be used. This attribute is useful if
   * there is no current session.
   */
  readonly type: string;

  /**
   * The session name.
   *
   * #### Notes
   * Typically `.session.name` should be used. This attribute is useful if
   * there is no current session.
   */
  readonly name: string;

  /**
   * Kill the kernel and shutdown the session.
   *
   * @returns A promise that resolves when the session is shut down.
   */
  shutdown(): Promise<void>;

  /**
   * Use a UX to select a new kernel for the session.
   */
  selectKernel(): Promise<void>;

  /**
   * Restart the kernel, with confirmation UX.
   *
   * @returns A promise that resolves with whether the kernel has restarted.
   *
   * #### Notes
   * This method makes it easy to get a new kernel running in a session where
   * we used to have a session running.
   *
   * * If there is a running kernel, present a confirmation dialog.
   * * If there is no kernel, start a kernel with the last-run kernel name.
   * * If no kernel has ever been started, this is a no-op, and resolves with
   *   `false`.
   */
  restart(): Promise<boolean>;
}

/**
 * The namespace for session context related interfaces.
 */
export namespace ISessionContext {
  /**
   * A kernel preference.
   *
   * #### Notes
   * Preferences for a kernel are considered in the order `id`, `name`,
   * `language`. If no matching kernels can be found and `autoStartDefault` is
   * `true`, then the default kernel for the server is preferred.
   */
  export interface IKernelPreference {
    /**
     * The name of the kernel.
     */
    readonly name?: string;

    /**
     * The preferred kernel language.
     */
    readonly language?: string;

    /**
     * The id of an existing kernel.
     */
    readonly id?: string;

    /**
     * A kernel should be started automatically (default `true`).
     */
    readonly shouldStart?: boolean;

    /**
     * A kernel can be started (default `true`).
     */
    readonly canStart?: boolean;

    /**
     * Shut down the session when session context is disposed (default `false`).
     */
    readonly shutdownOnDispose?: boolean;

    /**
     * Automatically start the default kernel if no other matching kernel is
     * found (default `true`).
     */
    readonly autoStartDefault?: boolean;
  }

  export type KernelDisplayStatus =
    | Kernel.Status
    | Kernel.ConnectionStatus
    | 'initializing'
    | '';
}

/**
 * The default implementation for a session context object.
 */
export class SessionContext implements ISessionContext {
  /**
   * Construct a new session context.
   */
  constructor(options: SessionContext.IOptions) {
    this.sessionManager = options.sessionManager;
    this.specsManager = options.specsManager;
    this._path = options.path ?? UUID.uuid4();
    this._type = options.type ?? '';
    this._name = options.name ?? '';
    this._setBusy = options.setBusy;
    this._kernelPreference = options.kernelPreference ?? {};
  }

  /**
   * The current session connection.
   */
  get session(): Session.ISessionConnection | null {
    return this._session ?? null;
  }

  /**
   * The session path.
   *
   * #### Notes
   * Typically `.session.path` should be used. This attribute is useful if
   * there is no current session.
   */
  get path(): string {
    return this._path;
  }

  /**
   * The session type.
   *
   * #### Notes
   * Typically `.session.type` should be used. This attribute is useful if
   * there is no current session.
   */
  get type(): string {
    return this._type;
  }

  /**
   * The session name.
   *
   * #### Notes
   * Typically `.session.name` should be used. This attribute is useful if
   * there is no current session.
   */
  get name(): string {
    return this._name;
  }

  /**
   * A signal emitted when the kernel connection changes, proxied from the session connection.
   */
  get kernelChanged(): ISignal<
    this,
    Session.ISessionConnection.IKernelChangedArgs
  > {
    return this._kernelChanged;
  }

  /**
   * A signal emitted when the session connection changes.
   */
  get sessionChanged(): ISignal<
    this,
    IChangedArgs<Session.ISessionConnection | null, 'session'>
  > {
    return this._sessionChanged;
  }

  /**
   * A signal emitted when the kernel status changes, proxied from the kernel.
   */
  get statusChanged(): ISignal<this, Kernel.Status> {
    return this._statusChanged;
  }

  /**
   * A signal emitted when the kernel status changes, proxied from the kernel.
   */
  get connectionStatusChanged(): ISignal<this, Kernel.ConnectionStatus> {
    return this._connectionStatusChanged;
  }

  /**
   * A signal emitted for iopub kernel messages, proxied from the kernel.
   */
  get iopubMessage(): ISignal<this, KernelMessage.IIOPubMessage> {
    return this._iopubMessage;
  }

  /**
   * A signal emitted for an unhandled kernel message, proxied from the kernel.
   */
  get unhandledMessage(): ISignal<this, KernelMessage.IMessage> {
    return this._unhandledMessage;
  }

  /**
   * A signal emitted when a session property changes, proxied from the current session.
   */
  get propertyChanged(): ISignal<this, 'path' | 'name' | 'type'> {
    return this._propertyChanged;
  }

  /**
   * The kernel preference of this client session.
   *
   * This is used when selecting a new kernel, and should reflect the sort of
   * kernel the activity prefers.
   */
  get kernelPreference(): ISessionContext.IKernelPreference {
    return this._kernelPreference;
  }
  set kernelPreference(value: ISessionContext.IKernelPreference) {
    this._kernelPreference = value;
  }

  /**
   * Whether the context is ready.
   */
  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * A promise that is fulfilled when the context is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * The session manager used by the session.
   */
  readonly sessionManager: Session.IManager;

  /**
   * The kernel spec manager
   */
  readonly specsManager: KernelSpec.IManager;

  /**
   * The display name of the current kernel, or a sensible alternative.
   *
   * #### Notes
   * This is a convenience function to have a consistent sensible name for the
   * kernel.
   */
  get kernelDisplayName(): string {
    let kernel = this.session?.kernel;
    if (
      !kernel &&
      !this.isReady &&
      this.kernelPreference.canStart !== false &&
      this.kernelPreference.shouldStart !== false
    ) {
      return 'Kernel';
    }
    if (!kernel) {
      return 'No Kernel!';
    }
    return (
      this.specsManager.specs?.kernelspecs[kernel.name]?.display_name ??
      kernel.name
    );
  }

  /**
   * A sensible status to display
   *
   * #### Notes
   * This combines the status and connection status into a single status for
   * the user.
   */
  get kernelDisplayStatus(): ISessionContext.KernelDisplayStatus {
    let kernel = this.session?.kernel;
    if (
      !kernel &&
      !this.isReady &&
      this.kernelPreference.canStart !== false &&
      this.kernelPreference.shouldStart !== false
    ) {
      return 'initializing';
    }

    return (
      (kernel?.connectionStatus === 'connected'
        ? kernel?.status
        : kernel?.connectionStatus) ?? ''
    );
  }

  /**
   * Test whether the client session is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A signal emitted when the poll is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Dispose of the resources held by the context.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    if (this._session) {
      if (this.kernelPreference.shutdownOnDispose) {
        // Fire and forget the session shutdown request
        this._session.shutdown().catch(reason => {
          console.error(`Kernel not shut down ${reason}`);
        });
      }

      // Dispose the session connection
      this._session.dispose();
      this._session = null;
    }
    if (this._dialog) {
      this._dialog.dispose();
    }
    if (this._busyDisposable) {
      this._busyDisposable.dispose();
      this._busyDisposable = null;
    }
    this._disposed.emit();
    Signal.clearData(this);
  }

  /**
   * Change the current kernel associated with the session.
   */
  async changeKernel(
    options: Partial<Kernel.IModel> = {}
  ): Promise<Kernel.IKernelConnection> {
    await this.initialize();
    if (this.isDisposed) {
      throw new Error('Disposed');
    }
    return this._changeKernel(options);
  }

  /**
   * Select a kernel for the session.
   */
  async selectKernel(): Promise<void> {
    await this.initialize();
    if (this.isDisposed) {
      throw new Error('Disposed');
    }
    return this._selectKernel(true);
  }

  /**
   * Shut down the session and kernel.
   *
   * @returns A promise that resolves when the session is shut down.
   */
  async shutdown(): Promise<void> {
    return this._session?.shutdown();
  }

  /**
   * Restart the session.
   *
   * @returns A promise that resolves with whether the kernel has restarted.
   *
   * #### Notes
   * If there is a running kernel, present a dialog.
   * If there is no kernel, we start a kernel with the last run
   * kernel name and resolves with `true`.
   */
  async restart(): Promise<boolean> {
    await this.initialize();
    if (this.isDisposed) {
      throw new Error('session already disposed');
    }
    let kernel = this.session?.kernel;
    if (kernel) {
      return SessionContext.restartKernel(kernel);
    }

    if (this._prevKernelName) {
      await this.changeKernel({ name: this._prevKernelName });
      return true;
    }

    // Bail if there is no previous kernel to start.
    throw new Error('No kernel to restart');
  }

  /**
   * Initialize the session.
   *
   * #### Notes
   * If a server session exists on the current path, we will connect to it.
   * If preferences include disabling `canStart` or `shouldStart`, no
   * server session will be started.
   * If a kernel id is given, we attempt to start a session with that id.
   * If a default kernel is available, we connect to it.
   * Otherwise we ask the user to select a kernel.
   */
  async initialize(): Promise<void> {
    if (this._initializing || this._isReady) {
      return this._ready.promise;
    }
    this._initializing = true;
    let manager = this.sessionManager;
    await manager.ready;
    let model = find(manager.running(), item => {
      return item.path === this._path;
    });
    if (model) {
      try {
        let session = manager.connectTo({ model });
        this._handleNewSession(session);
      } catch (err) {
        void this._handleSessionError(err);
        return Promise.reject(err);
      }
    }
    await this._startIfNecessary();
    this._isReady = true;
    this._ready.resolve(undefined);
  }

  /**
   * Start the session if necessary.
   */
  private async _startIfNecessary(): Promise<void> {
    let preference = this.kernelPreference;
    if (
      this.isDisposed ||
      this.session?.kernel ||
      preference.shouldStart === false ||
      preference.canStart === false
    ) {
      // Not necessary to start a kernel
      return;
    }

    let options: Partial<Kernel.IModel>;
    if (preference.id) {
      options = { id: preference.id };
    } else {
      let name = SessionContext.getDefaultKernel({
        specs: this.specsManager.specs,
        sessions: this.sessionManager.running(),
        preference
      });
      if (name) {
        options = { name };
      }
    }

    if (options) {
      try {
        await this._changeKernel(options);
        return;
      } catch (err) {
        /* no-op */
      }
    }

    // Always fall back to selecting a kernel
    await this._selectKernel(false);
  }

  /**
   * Change the kernel.
   */
  private async _changeKernel(
    options: Partial<Kernel.IModel> = {}
  ): Promise<Kernel.IKernelConnection> {
    if (this.isDisposed) {
      throw new Error('Disposed');
    }
    let session = this._session;
    if (session && session.kernel.status !== 'dead') {
      try {
        return session.changeKernel(options);
      } catch (err) {
        void this._handleSessionError(err);
        throw err;
      }
    } else {
      return this._startSession(options);
    }
  }

  /**
   * Select a kernel.
   *
   * @param cancelable: whether the dialog should have a cancel button.
   */
  private async _selectKernel(cancelable: boolean): Promise<void> {
    if (this.isDisposed) {
      return Promise.resolve();
    }
    const buttons = cancelable
      ? [Dialog.cancelButton(), Dialog.okButton({ label: 'Select' })]
      : [
          Dialog.cancelButton({ label: 'No Kernel' }),
          Dialog.okButton({ label: 'Select' })
        ];

    let dialog = (this._dialog = new Dialog({
      title: 'Select Kernel',
      body: new Private.KernelSelector(this),
      buttons
    }));

    let result = await dialog.launch();
    dialog.dispose();
    this._dialog = null;

    if (this.isDisposed || !result.button.accept) {
      return;
    }
    let model = result.value;
    if (model === null && this._session) {
      await this.shutdown();
    } else if (model) {
      await this._changeKernel(model);
    }
  }

  /**
   * Start a session and set up its signals.
   */
  private async _startSession(
    model: Partial<Kernel.IModel> = {}
  ): Promise<Kernel.IKernelConnection> {
    if (this.isDisposed) {
      throw 'Client session is disposed.';
    }
    try {
      const session = await this.sessionManager.startNew({
        path: this._path,
        type: this._type,
        name: this._name,
        kernel: model
      });
      return this._handleNewSession(session);
    } catch (err) {
      void this._handleSessionError(err);
      throw err;
    }
  }

  /**
   * Handle a new session object.
   */
  private _handleNewSession(
    session: Session.ISessionConnection
  ): Kernel.IKernelConnection | null {
    if (this.isDisposed) {
      throw Error('Disposed');
    }
    if (this._session) {
      this._session.dispose();
    }
    this._session = session;
    this._prevKernelName = session.kernel?.name;

    session.disposed.connect(this._onSessionDisposed, this);
    session.propertyChanged.connect(this._onPropertyChanged, this);
    session.kernelChanged.connect(this._onKernelChanged, this);
    session.statusChanged.connect(this._onStatusChanged, this);
    session.connectionStatusChanged.connect(
      this._onConnectionStatusChanged,
      this
    );
    session.iopubMessage.connect(this._onIopubMessage, this);
    session.unhandledMessage.connect(this._onUnhandledMessage, this);

    if (session.path !== this._path) {
      this._onPropertyChanged(session, 'path');
    }
    if (session.name !== this._name) {
      this._onPropertyChanged(session, 'name');
    }
    if (session.type !== this._type) {
      this._onPropertyChanged(session, 'type');
    }

    // Any existing kernel connection was disposed above when the session was
    // disposed, so the oldValue should be null.
    this._kernelChanged.emit({
      oldValue: null,
      newValue: session.kernel,
      name: 'kernel'
    });
    return session.kernel;
  }

  /**
   * Handle an error in session startup.
   */
  private async _handleSessionError(
    err: ServerConnection.ResponseError
  ): Promise<void> {
    let text = await err.response.text();
    let message = err.message;
    try {
      message = JSON.parse(text)['traceback'];
    } catch (err) {
      // no-op
    }
    let dialog = (this._dialog = new Dialog({
      title: 'Error Starting Kernel',
      body: <pre>{message}</pre>,
      buttons: [Dialog.okButton()]
    }));
    await dialog.launch();
    this._dialog = null;
  }

  /**
   * Handle a session termination.
   */
  private _onSessionDisposed(): void {
    if (this._session) {
      this._session.dispose();
    }
    this._session = null;
    this._terminated.emit(undefined);
  }

  /**
   * Handle a change to a session property.
   */
  private _onPropertyChanged(
    sender: Session.ISessionConnection,
    property: 'path' | 'name' | 'type'
  ) {
    switch (property) {
      case 'path':
        this._path = sender.path;
        break;
      case 'name':
        this._name = sender.name;
        break;
      case 'type':
        this._type = sender.type;
        break;
      default:
        throw new Error(`unrecognized property ${property}`);
    }
    this._propertyChanged.emit(property);
  }

  /**
   * Handle a change to the kernel.
   */
  private _onKernelChanged(
    sender: Session.ISessionConnection,
    args: Session.ISessionConnection.IKernelChangedArgs
  ): void {
    this._kernelChanged.emit(args);
  }

  /**
   * Handle a change to the session status.
   */
  private _onStatusChanged(
    sender: Session.ISessionConnection,
    status: Kernel.Status
  ): void {
    // Set that this kernel is busy, if we haven't already
    // If we have already, and now we aren't busy, dispose
    // of the busy disposable.
    if (this._setBusy) {
      if (status === 'busy') {
        if (!this._busyDisposable) {
          this._busyDisposable = this._setBusy();
        }
      } else {
        if (this._busyDisposable) {
          this._busyDisposable.dispose();
          this._busyDisposable = null;
        }
      }
    }

    // Proxy the signal
    this._statusChanged.emit(status);
  }

  /**
   * Handle a change to the session status.
   */
  private _onConnectionStatusChanged(
    sender: Session.ISessionConnection,
    status: Kernel.ConnectionStatus
  ): void {
    // Proxy the signal
    this._connectionStatusChanged.emit(status);
  }

  /**
   * Handle an iopub message.
   */
  private _onIopubMessage(
    sender: Session.ISessionConnection,
    message: KernelMessage.IIOPubMessage
  ): void {
    this._iopubMessage.emit(message);
  }

  /**
   * Handle an unhandled message.
   */
  private _onUnhandledMessage(
    sender: Session.ISessionConnection,
    message: KernelMessage.IMessage
  ): void {
    this._unhandledMessage.emit(message);
  }

  private _path = '';
  private _name = '';
  private _type = '';
  private _prevKernelName = '';
  private _kernelPreference: ISessionContext.IKernelPreference;
  private _isDisposed = false;
  private _disposed = new Signal<this, void>(this);
  private _session: Session.ISessionConnection | null = null;
  private _ready = new PromiseDelegate<void>();
  private _initializing = false;
  private _isReady = false;
  private _terminated = new Signal<this, void>(this);
  private _kernelChanged = new Signal<
    this,
    Session.ISessionConnection.IKernelChangedArgs
  >(this);
  private _sessionChanged = new Signal<
    this,
    IChangedArgs<Session.ISessionConnection | null, 'session'>
  >(this);
  private _statusChanged = new Signal<this, Kernel.Status>(this);
  private _connectionStatusChanged = new Signal<this, Kernel.ConnectionStatus>(
    this
  );
  private _iopubMessage = new Signal<this, KernelMessage.IIOPubMessage>(this);
  private _unhandledMessage = new Signal<this, KernelMessage.IMessage>(this);
  private _propertyChanged = new Signal<this, 'path' | 'name' | 'type'>(this);
  private _dialog: Dialog<any> | null = null;
  private _setBusy: () => IDisposable | undefined;
  private _busyDisposable: IDisposable | null = null;
}

/**
 * A namespace for `SessionContext` statics.
 */
export namespace SessionContext {
  /**
   * The options used to initialize a context.
   */
  export interface IOptions {
    /**
     * A session manager instance.
     */
    sessionManager: Session.IManager;

    /**
     * A kernel spec manager instance.
     */
    specsManager: KernelSpec.IManager;

    /**
     * The initial path of the file.
     */
    path?: string;

    /**
     * The name of the session.
     */
    name?: string;

    /**
     * The type of the session.
     */
    type?: string;

    /**
     * A kernel preference.
     */
    kernelPreference?: ISessionContext.IKernelPreference;

    /**
     * A function to call when the session becomes busy.
     */
    setBusy?: () => IDisposable;
  }

  /**
   * Restart a kernel if the user accepts the risk.
   *
   * Returns a promise resolving with whether the kernel was restarted.
   */
  export async function restartKernel(
    kernel: Kernel.IKernelConnection
  ): Promise<boolean> {
    let restartBtn = Dialog.warnButton({ label: 'Restart' });
    const result = await showDialog({
      title: 'Restart Kernel?',
      body:
        'Do you want to restart the current kernel? All variables will be lost.',
      buttons: [Dialog.cancelButton(), restartBtn]
    });

    if (kernel.isDisposed) {
      return false;
    }
    if (result.button.accept) {
      await kernel.restart();
      return true;
    }
    return false;
  }

  /**
   * An interface for populating a kernel selector.
   */
  export interface IKernelSearch {
    /**
     * The Kernel specs.
     */
    specs: KernelSpec.ISpecModels | null;

    /**
     * The kernel preference.
     */
    preference: ISessionContext.IKernelPreference;

    /**
     * The current running sessions.
     */
    sessions?: IterableOrArrayLike<Session.IModel>;
  }

  /**
   * Get the default kernel name given select options.
   */
  export function getDefaultKernel(options: IKernelSearch): string | null {
    return Private.getDefaultKernel(options);
  }

  /**
   * Populate a kernel dropdown list.
   *
   * @param node - The node to populate.
   *
   * @param options - The options used to populate the kernels.
   *
   * #### Notes
   * Populates the list with separated sections:
   *   - Kernels matching the preferred language (display names).
   *   - "None" signifying no kernel.
   *   - The remaining kernels.
   *   - Sessions matching the preferred language (file names).
   *   - The remaining sessions.
   * If no preferred language is given or no kernels are found using
   * the preferred language, the default kernel is used in the first
   * section.  Kernels are sorted by display name.  Sessions display the
   * base name of the file with an ellipsis overflow and a tooltip with
   * the explicit session information.
   */
  export function populateKernelSelect(
    node: HTMLSelectElement,
    options: IKernelSearch
  ): void {
    return Private.populateKernelSelect(node, options);
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * A widget that provides a kernel selection.
   */
  export class KernelSelector extends Widget {
    /**
     * Create a new kernel selector widget.
     */
    constructor(sessionContext: SessionContext) {
      super({ node: createSelectorNode(sessionContext) });
    }

    /**
     * Get the value of the kernel selector widget.
     */
    getValue(): Kernel.IModel {
      let selector = this.node.querySelector('select') as HTMLSelectElement;
      return JSON.parse(selector.value) as Kernel.IModel;
    }
  }

  /**
   * Create a node for a kernel selector widget.
   */
  function createSelectorNode(sessionContext: SessionContext) {
    // Create the dialog body.
    let body = document.createElement('div');
    let text = document.createElement('label');
    text.textContent = `Select kernel for: "${sessionContext.name}"`;
    body.appendChild(text);

    let options = getKernelSearch(sessionContext);
    let selector = document.createElement('select');
    SessionContext.populateKernelSelect(selector, options);
    body.appendChild(selector);
    return body;
  }

  /**
   * Get the default kernel name given select options.
   */
  export function getDefaultKernel(
    options: SessionContext.IKernelSearch
  ): string | null {
    let { specs, preference } = options;
    let {
      name,
      language,
      shouldStart,
      canStart,
      autoStartDefault
    } = preference;

    if (!specs || shouldStart === false || canStart === false) {
      return null;
    }

    let defaultName = autoStartDefault ? specs.default : null;

    if (!name && !language) {
      return defaultName;
    }

    // Look for an exact match of a spec name.
    for (let specName in specs.kernelspecs) {
      if (specName === name) {
        return name;
      }
    }

    // Bail if there is no language.
    if (!language) {
      return defaultName;
    }

    // Check for a single kernel matching the language.
    let matches: string[] = [];
    for (let specName in specs.kernelspecs) {
      let kernelLanguage = specs.kernelspecs[specName].language;
      if (language === kernelLanguage) {
        matches.push(specName);
      }
    }

    if (matches.length === 1) {
      let specName = matches[0];
      console.log(
        'No exact match found for ' +
          specName +
          ', using kernel ' +
          specName +
          ' that matches ' +
          'language=' +
          language
      );
      return specName;
    }

    // No matches found.
    return defaultName;
  }

  /**
   * Populate a kernel select node for the session.
   */
  export function populateKernelSelect(
    node: HTMLSelectElement,
    options: SessionContext.IKernelSearch
  ): void {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }

    let { preference, sessions, specs } = options;
    let { name, id, language, canStart, shouldStart } = preference;

    if (!specs || canStart === false) {
      node.appendChild(optionForNone());
      node.value = 'null';
      node.disabled = true;
      return;
    }

    node.disabled = false;

    // Create mappings of display names and languages for kernel name.
    let displayNames: { [key: string]: string } = Object.create(null);
    let languages: { [key: string]: string } = Object.create(null);
    for (let name in specs.kernelspecs) {
      let spec = specs.kernelspecs[name];
      displayNames[name] = spec.display_name;
      languages[name] = spec.language;
    }

    // Handle a kernel by name.
    let names: string[] = [];
    if (name && name in specs.kernelspecs) {
      names.push(name);
    }

    // Then look by language.
    if (language) {
      for (let specName in specs.kernelspecs) {
        if (name !== specName && languages[specName] === language) {
          names.push(specName);
        }
      }
    }

    // Use the default kernel if no kernels were found.
    if (!names.length) {
      names.push(specs.default);
    }

    // Handle a preferred kernels in order of display name.
    let preferred = document.createElement('optgroup');
    preferred.label = 'Start Preferred Kernel';

    names.sort((a, b) => displayNames[a].localeCompare(displayNames[b]));
    for (let name of names) {
      preferred.appendChild(optionForName(name, displayNames[name]));
    }

    if (preferred.firstChild) {
      node.appendChild(preferred);
    }

    // Add an option for no kernel
    node.appendChild(optionForNone());

    let other = document.createElement('optgroup');
    other.label = 'Start Other Kernel';

    // Add the rest of the kernel names in alphabetical order.
    let otherNames: string[] = [];
    for (let specName in specs.kernelspecs) {
      if (names.indexOf(specName) !== -1) {
        continue;
      }
      otherNames.push(specName);
    }
    otherNames.sort((a, b) => displayNames[a].localeCompare(displayNames[b]));
    for (let otherName of otherNames) {
      other.appendChild(optionForName(otherName, displayNames[otherName]));
    }
    // Add a separator option if there were any other names.
    if (otherNames.length) {
      node.appendChild(other);
    }

    // Handle the default value.
    if (shouldStart === false) {
      node.value = 'null';
    } else {
      node.selectedIndex = 0;
    }

    // Bail if there are no sessions.
    if (!sessions) {
      return;
    }

    // Add the sessions using the preferred language first.
    let matchingSessions: Session.IModel[] = [];
    let otherSessions: Session.IModel[] = [];

    each(sessions, session => {
      if (
        language &&
        languages[session.kernel.name] === language &&
        session.kernel.id !== id
      ) {
        matchingSessions.push(session);
      } else if (session.kernel.id !== id) {
        otherSessions.push(session);
      }
    });

    let matching = document.createElement('optgroup');
    matching.label = 'Use Kernel from Preferred Session';
    node.appendChild(matching);

    if (matchingSessions.length) {
      matchingSessions.sort((a, b) => {
        return a.path.localeCompare(b.path);
      });

      each(matchingSessions, session => {
        let name = displayNames[session.kernel.name];
        matching.appendChild(optionForSession(session, name));
      });
    }

    let otherSessionsNode = document.createElement('optgroup');
    otherSessionsNode.label = 'Use Kernel from Other Session';
    node.appendChild(otherSessionsNode);

    if (otherSessions.length) {
      otherSessions.sort((a, b) => {
        return a.path.localeCompare(b.path);
      });

      each(otherSessions, session => {
        let name = displayNames[session.kernel.name] || session.kernel.name;
        otherSessionsNode.appendChild(optionForSession(session, name));
      });
    }
  }

  /**
   * Get the kernel search options given a session context.
   */
  function getKernelSearch(
    sessionContext: SessionContext
  ): SessionContext.IKernelSearch {
    return {
      specs: sessionContext.specsManager.specs,
      sessions: sessionContext.sessionManager.running(),
      preference: sessionContext.kernelPreference
    };
  }

  /**
   * Create an option element for a kernel name.
   */
  function optionForName(name: string, displayName: string): HTMLOptionElement {
    let option = document.createElement('option');
    option.text = displayName;
    option.value = JSON.stringify({ name });
    return option;
  }

  /**
   * Create an option for no kernel.
   */
  function optionForNone(): HTMLOptGroupElement {
    let group = document.createElement('optgroup');
    group.label = 'Use No Kernel';
    let option = document.createElement('option');
    option.text = 'No Kernel';
    option.value = 'null';
    group.appendChild(option);
    return group;
  }

  /**
   * Create an option element for a session.
   */
  function optionForSession(
    session: Session.IModel,
    displayName: string
  ): HTMLOptionElement {
    let option = document.createElement('option');
    let sessionName = session.name || PathExt.basename(session.path);
    option.text = sessionName;
    option.value = JSON.stringify({ id: session.kernel.id });
    option.title =
      `Path: ${session.path}\n` +
      `Name: ${sessionName}\n` +
      `Kernel Name: ${displayName}\n` +
      `Kernel Id: ${session.kernel.id}`;
    return option;
  }
}
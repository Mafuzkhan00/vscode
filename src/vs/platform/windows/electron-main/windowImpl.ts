/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, Display, nativeImage, NativeImage, Rectangle, screen, SegmentedControlSegment, systemPreferences, TouchBar, TouchBarSegmentedControl } from 'electron';
import { DeferredPromise, RunOnceScheduler, timeout } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { FileAccess, Schemas } from 'vs/base/common/network';
import { getMarks, mark } from 'vs/base/common/performance';
import { isBigSurOrNewer, isMacintosh, isWindows } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { release } from 'os';
import { ISerializableCommandAction } from 'vs/platform/action/common/action';
import { IBackupMainService } from 'vs/platform/backup/electron-main/backup';
import { IConfigurationChangeEvent, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IDialogMainService } from 'vs/platform/dialogs/electron-main/dialogMainService';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { IEnvironmentMainService } from 'vs/platform/environment/electron-main/environmentMainService';
import { isLaunchedFromCli } from 'vs/platform/environment/node/argvHelper';
import { IFileService } from 'vs/platform/files/common/files';
import { ILifecycleMainService } from 'vs/platform/lifecycle/electron-main/lifecycleMainService';
import { ILogService } from 'vs/platform/log/common/log';
import { IProductService } from 'vs/platform/product/common/productService';
import { IProtocolMainService } from 'vs/platform/protocol/electron-main/protocol';
import { resolveMarketplaceHeaders } from 'vs/platform/externalServices/common/marketplace';
import { IApplicationStorageMainService, IStorageMainService } from 'vs/platform/storage/electron-main/storageMainService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ThemeIcon } from 'vs/base/common/themables';
import { IThemeMainService } from 'vs/platform/theme/electron-main/themeMainService';
import { getMenuBarVisibility, IFolderToOpen, INativeWindowConfiguration, IWindowSettings, IWorkspaceToOpen, MenuBarVisibility, hasNativeTitlebar, useNativeFullScreen, useWindowControlsOverlay } from 'vs/platform/window/common/window';
import { defaultBrowserWindowOptions, IWindowsMainService, OpenContext, WindowStateValidator } from 'vs/platform/windows/electron-main/windows';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, toWorkspaceIdentifier } from 'vs/platform/workspace/common/workspace';
import { IWorkspacesManagementMainService } from 'vs/platform/workspaces/electron-main/workspacesManagementMainService';
import { IWindowState, ICodeWindow, ILoadEvent, WindowMode, WindowError, LoadReason, defaultWindowState, IBaseWindow } from 'vs/platform/window/electron-main/window';
import { IPolicyService } from 'vs/platform/policy/common/policy';
import { IUserDataProfile } from 'vs/platform/userDataProfile/common/userDataProfile';
import { IStateService } from 'vs/platform/state/node/state';
import { IUserDataProfilesMainService } from 'vs/platform/userDataProfile/electron-main/userDataProfile';
import { ILoggerMainService } from 'vs/platform/log/electron-main/loggerService';
import { firstOrDefault } from 'vs/base/common/arrays';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

export interface IWindowCreationOptions {
	readonly state: IWindowState;
	readonly extensionDevelopmentPath?: string[];
	readonly isExtensionTestHost?: boolean;
}

interface ITouchBarSegment extends SegmentedControlSegment {
	readonly id: string;
}

interface ILoadOptions {
	readonly isReload?: boolean;
	readonly disableExtensions?: boolean;
}

const enum ReadyState {

	/**
	 * This window has not loaded anything yet
	 * and this is the initial state of every
	 * window.
	 */
	NONE,

	/**
	 * This window is navigating, either for the
	 * first time or subsequent times.
	 */
	NAVIGATING,

	/**
	 * This window has finished loading and is ready
	 * to forward IPC requests to the web contents.
	 */
	READY
}

export abstract class BaseWindow extends Disposable implements IBaseWindow {

	//#region Events

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidMaximize = this._register(new Emitter<void>());
	readonly onDidMaximize = this._onDidMaximize.event;

	private readonly _onDidUnmaximize = this._register(new Emitter<void>());
	readonly onDidUnmaximize = this._onDidUnmaximize.event;

	private readonly _onDidTriggerSystemContextMenu = this._register(new Emitter<{ x: number; y: number }>());
	readonly onDidTriggerSystemContextMenu = this._onDidTriggerSystemContextMenu.event;

	private readonly _onDidEnterFullScreen = this._register(new Emitter<void>());
	readonly onDidEnterFullScreen = this._onDidEnterFullScreen.event;

	private readonly _onDidLeaveFullScreen = this._register(new Emitter<void>());
	readonly onDidLeaveFullScreen = this._onDidLeaveFullScreen.event;

	//#endregion

	abstract readonly id: number;

	protected _lastFocusTime = Date.now(); // window is shown on creation so take current time
	get lastFocusTime(): number { return this._lastFocusTime; }

	protected _win: BrowserWindow | null = null;
	get win() { return this._win; }
	protected setWin(win: BrowserWindow): void {
		this._win = win;

		// Window Events
		this._register(Event.fromNodeEventEmitter(win, 'maximize')(() => this._onDidMaximize.fire()));
		this._register(Event.fromNodeEventEmitter(win, 'unmaximize')(() => this._onDidUnmaximize.fire()));
		this._register(Event.fromNodeEventEmitter(win, 'closed')(() => {
			this._onDidClose.fire();

			this.dispose();
		}));
		this._register(Event.fromNodeEventEmitter(win, 'focus')(() => {
			this._lastFocusTime = Date.now();
		}));
		this._register(Event.fromNodeEventEmitter(this._win, 'enter-full-screen')(() => this._onDidEnterFullScreen.fire()));
		this._register(Event.fromNodeEventEmitter(this._win, 'leave-full-screen')(() => this._onDidLeaveFullScreen.fire()));

		// Sheet Offsets
		const useCustomTitleStyle = !hasNativeTitlebar(this.configurationService);
		if (isMacintosh && useCustomTitleStyle) {
			win.setSheetOffset(isBigSurOrNewer(release()) ? 28 : 22); // offset dialogs by the height of the custom title bar if we have any
		}

		// Update the window controls immediately based on cached values
		if (useCustomTitleStyle && ((isWindows && useWindowControlsOverlay(this.configurationService)) || isMacintosh)) {
			const cachedWindowControlHeight = this.stateService.getItem<number>((BaseWindow.windowControlHeightStateStorageKey));
			if (cachedWindowControlHeight) {
				this.updateWindowControls({ height: cachedWindowControlHeight });
			}
		}

		// Windows Custom System Context Menu
		// See https://github.com/electron/electron/issues/24893
		//
		// The purpose of this is to allow for the context menu in the Windows Title Bar
		//
		// Currently, all mouse events in the title bar are captured by the OS
		// thus we need to capture them here with a window hook specific to Windows
		// and then forward them to the correct window.
		if (isWindows && useCustomTitleStyle) {
			const WM_INITMENU = 0x0116; // https://docs.microsoft.com/en-us/windows/win32/menurc/wm-initmenu

			// This sets up a listener for the window hook. This is a Windows-only API provided by electron.
			win.hookWindowMessage(WM_INITMENU, () => {
				const [x, y] = win.getPosition();
				const cursorPos = screen.getCursorScreenPoint();
				const cx = cursorPos.x - x;
				const cy = cursorPos.y - y;

				// In some cases, show the default system context menu
				// 1) The mouse position is not within the title bar
				// 2) The mouse position is within the title bar, but over the app icon
				// We do not know the exact title bar height but we make an estimate based on window height
				const shouldTriggerDefaultSystemContextMenu = () => {
					// Use the custom context menu when over the title bar, but not over the app icon
					// The app icon is estimated to be 30px wide
					// The title bar is estimated to be the max of 35px and 15% of the window height
					if (cx > 30 && cy >= 0 && cy <= Math.max(win.getBounds().height * 0.15, 35)) {
						return false;
					}

					return true;
				};

				if (!shouldTriggerDefaultSystemContextMenu()) {

					// This is necessary to make sure the native system context menu does not show up.
					win.setEnabled(false);
					win.setEnabled(true);

					this._onDidTriggerSystemContextMenu.fire({ x: cx, y: cy });
				}

				return 0;
			});
		}

		// Open devtools if instructed from command line args
		if (this.environmentMainService.args['open-devtools'] === true) {
			win.webContents.openDevTools();
		}

		// macOS: Window Fullscreen Transitions
		if (isMacintosh) {
			this._register(this.onDidEnterFullScreen(() => {
				this.joinNativeFullScreenTransition?.complete(true);
			}));

			this._register(this.onDidLeaveFullScreen(() => {
				this.joinNativeFullScreenTransition?.complete(true);
			}));
		}
	}

	constructor(
		protected readonly configurationService: IConfigurationService,
		protected readonly stateService: IStateService,
		protected readonly environmentMainService: IEnvironmentMainService,
		protected readonly logService: ILogService
	) {
		super();
	}

	private representedFilename: string | undefined;

	setRepresentedFilename(filename: string): void {
		if (isMacintosh) {
			this.win?.setRepresentedFilename(filename);
		} else {
			this.representedFilename = filename;
		}
	}

	getRepresentedFilename(): string | undefined {
		if (isMacintosh) {
			return this.win?.getRepresentedFilename();
		}

		return this.representedFilename;
	}

	private documentEdited: boolean | undefined;

	setDocumentEdited(edited: boolean): void {
		if (isMacintosh) {
			this.win?.setDocumentEdited(edited);
		}

		this.documentEdited = edited;
	}

	isDocumentEdited(): boolean {
		if (isMacintosh) {
			return Boolean(this.win?.isDocumentEdited());
		}

		return !!this.documentEdited;
	}

	focus(options?: { force: boolean }): void {
		if (isMacintosh && options?.force) {
			app.focus({ steal: true });
		}

		const win = this.win;
		if (!win) {
			return;
		}

		if (win.isMinimized()) {
			win.restore();
		}

		win.focus();
	}

	handleTitleDoubleClick(): void {
		const win = this.win;
		if (!win) {
			return;
		}

		// Respect system settings on mac with regards to title click on windows title
		if (isMacintosh) {
			const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
			switch (action) {
				case 'Minimize':
					win.minimize();
					break;
				case 'None':
					break;
				case 'Maximize':
				default:
					if (win.isMaximized()) {
						win.unmaximize();
					} else {
						win.maximize();
					}
			}
		}

		// Linux/Windows: just toggle maximize/minimized state
		else {
			if (win.isMaximized()) {
				win.unmaximize();
			} else {
				win.maximize();
			}
		}
	}

	//#region WCO

	private static readonly windowControlHeightStateStorageKey = 'windowControlHeight';

	private readonly hasWindowControlOverlay = useWindowControlsOverlay(this.configurationService);

	updateWindowControls(options: { height?: number; backgroundColor?: string; foregroundColor?: string }): void {
		const win = this.win;
		if (!win) {
			return;
		}

		// Cache the height for speeds lookups on startup
		if (options.height) {
			this.stateService.setItem((CodeWindow.windowControlHeightStateStorageKey), options.height);
		}

		// Windows: window control overlay (WCO)
		if (isWindows && this.hasWindowControlOverlay) {
			win.setTitleBarOverlay({
				color: options.backgroundColor?.trim() === '' ? undefined : options.backgroundColor,
				symbolColor: options.foregroundColor?.trim() === '' ? undefined : options.foregroundColor,
				height: options.height ? options.height - 1 : undefined // account for window border
			});
		}

		// macOS: traffic lights
		else if (isMacintosh && options.height !== undefined) {
			const verticalOffset = (options.height - 15) / 2; // 15px is the height of the traffic lights
			if (!verticalOffset) {
				win.setWindowButtonPosition(null);
			} else {
				win.setWindowButtonPosition({ x: verticalOffset, y: verticalOffset });
			}
		}
	}

	//#endregion

	//#region Fullscreen

	private transientIsNativeFullScreen: boolean | undefined = undefined;
	private joinNativeFullScreenTransition: DeferredPromise<boolean> | undefined = undefined;

	toggleFullScreen(): void {
		this.setFullScreen(!this.isFullScreen, false);
	}

	protected setFullScreen(fullscreen: boolean, fromRestore: boolean): void {

		// Set fullscreen state
		if (useNativeFullScreen(this.configurationService)) {
			this.setNativeFullScreen(fullscreen, fromRestore);
		} else {
			this.setSimpleFullScreen(fullscreen);
		}
	}

	get isFullScreen(): boolean {
		if (isMacintosh && typeof this.transientIsNativeFullScreen === 'boolean') {
			return this.transientIsNativeFullScreen;
		}

		const win = this.win;
		const isFullScreen = win?.isFullScreen();
		const isSimpleFullScreen = win?.isSimpleFullScreen();

		return Boolean(isFullScreen || isSimpleFullScreen);
	}

	private setNativeFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		const win = this.win;
		if (win?.isSimpleFullScreen()) {
			win?.setSimpleFullScreen(false);
		}

		this.doSetNativeFullScreen(fullscreen, fromRestore);
	}

	private doSetNativeFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		if (isMacintosh) {

			// macOS: Electron windows report `false` for `isFullScreen()` for as long
			// as the fullscreen transition animation takes place. As such, we need to
			// listen to the transition events and carry around an intermediate state
			// for knowing if we are in fullscreen or not
			// Refs: https://github.com/electron/electron/issues/35360

			this.transientIsNativeFullScreen = fullscreen;

			const joinNativeFullScreenTransition = this.joinNativeFullScreenTransition = new DeferredPromise<boolean>();
			(async () => {
				const transitioned = await Promise.race([
					joinNativeFullScreenTransition.p,
					timeout(10000).then(() => false)
				]);

				if (this.joinNativeFullScreenTransition !== joinNativeFullScreenTransition) {
					return; // another transition was requested later
				}

				this.transientIsNativeFullScreen = undefined;
				this.joinNativeFullScreenTransition = undefined;

				// There is one interesting gotcha on macOS: when you are opening a new
				// window from a fullscreen window, that new window will immediately
				// open fullscreen and emit the `enter-full-screen` event even before we
				// reach this method. In that case, we actually will timeout after 10s
				// for detecting the transition and as such it is important that we only
				// signal to leave fullscreen if the window reports as not being in fullscreen.

				if (!transitioned && fullscreen && fromRestore && this.win && !this.win.isFullScreen()) {

					// We have seen requests for fullscreen failing eventually after some
					// time, for example when an OS update was performed and windows restore.
					// In those cases a user would find a window that is not in fullscreen
					// but also does not show any custom titlebar (and thus window controls)
					// because we think the window is in fullscreen.
					//
					// As a workaround in that case we emit a warning and leave fullscreen
					// so that at least the window controls are back.

					this.logService.warn('window: native macOS fullscreen transition did not happen within 10s from restoring');

					this._onDidLeaveFullScreen.fire();
				}
			})();
		}

		const win = this.win;
		win?.setFullScreen(fullscreen);
	}

	private setSimpleFullScreen(fullscreen: boolean): void {
		const win = this.win;
		if (win?.isFullScreen()) {
			this.doSetNativeFullScreen(false, false);
		}

		win?.setSimpleFullScreen(fullscreen);
		win?.webContents.focus(); // workaround issue where focus is not going into window
	}

	//#endregion

	override dispose(): void {
		super.dispose();

		this._win = null!; // Important to dereference the window object to allow for GC
	}
}

export class CodeWindow extends BaseWindow implements ICodeWindow {

	//#region Events

	private readonly _onWillLoad = this._register(new Emitter<ILoadEvent>());
	readonly onWillLoad = this._onWillLoad.event;

	private readonly _onDidSignalReady = this._register(new Emitter<void>());
	readonly onDidSignalReady = this._onDidSignalReady.event;

	private readonly _onDidDestroy = this._register(new Emitter<void>());
	readonly onDidDestroy = this._onDidDestroy.event;

	//#endregion


	//#region Properties

	private _id: number;
	get id(): number { return this._id; }

	protected override _win: BrowserWindow;

	get backupPath(): string | undefined { return this._config?.backupPath; }

	get openedWorkspace(): IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined { return this._config?.workspace; }

	get profile(): IUserDataProfile | undefined {
		if (!this.config) {
			return undefined;
		}

		const profile = this.userDataProfilesService.profiles.find(profile => profile.id === this.config?.profiles.profile.id);
		if (this.isExtensionDevelopmentHost && profile) {
			return profile;
		}

		return this.userDataProfilesService.getProfileForWorkspace(this.config.workspace ?? toWorkspaceIdentifier(this.backupPath, this.isExtensionDevelopmentHost)) ?? this.userDataProfilesService.defaultProfile;
	}

	get remoteAuthority(): string | undefined { return this._config?.remoteAuthority; }

	private _config: INativeWindowConfiguration | undefined;
	get config(): INativeWindowConfiguration | undefined { return this._config; }

	get isExtensionDevelopmentHost(): boolean { return !!(this._config?.extensionDevelopmentPath); }

	get isExtensionTestHost(): boolean { return !!(this._config?.extensionTestsPath); }

	get isExtensionDevelopmentTestFromCli(): boolean { return this.isExtensionDevelopmentHost && this.isExtensionTestHost && !this._config?.debugId; }

	//#endregion

	private readonly windowState: IWindowState;
	private currentMenuBarVisibility: MenuBarVisibility | undefined;

	private readonly whenReadyCallbacks: { (window: ICodeWindow): void }[] = [];

	private readonly touchBarGroups: TouchBarSegmentedControl[] = [];

	private currentHttpProxy: string | undefined = undefined;
	private currentNoProxy: string | undefined = undefined;

	private customZoomLevel: number | undefined = undefined;

	private readonly configObjectUrl = this._register(this.protocolMainService.createIPCObjectUrl<INativeWindowConfiguration>());
	private pendingLoadConfig: INativeWindowConfiguration | undefined;
	private wasLoaded = false;

	constructor(
		config: IWindowCreationOptions,
		@ILogService logService: ILogService,
		@ILoggerMainService private readonly loggerMainService: ILoggerMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IPolicyService private readonly policyService: IPolicyService,
		@IUserDataProfilesMainService private readonly userDataProfilesService: IUserDataProfilesMainService,
		@IFileService private readonly fileService: IFileService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@IStorageMainService private readonly storageMainService: IStorageMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IWorkspacesManagementMainService private readonly workspacesManagementMainService: IWorkspacesManagementMainService,
		@IBackupMainService private readonly backupMainService: IBackupMainService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IProductService private readonly productService: IProductService,
		@IProtocolMainService private readonly protocolMainService: IProtocolMainService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IStateService stateService: IStateService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(configurationService, stateService, environmentMainService, logService);

		//#region create browser window
		{
			// Load window state
			const [state, hasMultipleDisplays] = this.restoreWindowState(config.state);
			this.windowState = state;
			this.logService.trace('window#ctor: using window state', state);

			// In case we are maximized or fullscreen, only show later
			// after the call to maximize/fullscreen (see below)
			const isFullscreenOrMaximized = (this.windowState.mode === WindowMode.Maximized || this.windowState.mode === WindowMode.Fullscreen);

			const options = instantiationService.invokeFunction(defaultBrowserWindowOptions, this.windowState, {
				show: !isFullscreenOrMaximized, // reduce flicker by showing later
				webPreferences: {
					preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-sandbox/preload.js').fsPath,
					additionalArguments: [`--vscode-window-config=${this.configObjectUrl.resource.toString()}`],
					v8CacheOptions: this.environmentMainService.useCodeCache ? 'bypassHeatCheck' : 'none',
				}
			});


			// Create the browser window
			mark('code/willCreateCodeBrowserWindow');
			this._win = new BrowserWindow(options);
			mark('code/didCreateCodeBrowserWindow');

			this._id = this._win.id;
			this.setWin(this._win);

			// TODO@electron (Electron 4 regression): when running on multiple displays where the target display
			// to open the window has a larger resolution than the primary display, the window will not size
			// correctly unless we set the bounds again (https://github.com/microsoft/vscode/issues/74872)
			//
			// Extended to cover Windows as well as Mac (https://github.com/microsoft/vscode/issues/146499)
			//
			// However, when running with native tabs with multiple windows we cannot use this workaround
			// because there is a potential that the new window will be added as native tab instead of being
			// a window on its own. In that case calling setBounds() would cause https://github.com/microsoft/vscode/issues/75830
			const windowSettings = this.configurationService.getValue<IWindowSettings | undefined>('window');
			const useNativeTabs = isMacintosh && windowSettings?.nativeTabs === true;
			if ((isMacintosh || isWindows) && hasMultipleDisplays && (!useNativeTabs || BrowserWindow.getAllWindows().length === 1)) {
				if ([this.windowState.width, this.windowState.height, this.windowState.x, this.windowState.y].every(value => typeof value === 'number')) {
					this._win.setBounds({
						width: this.windowState.width,
						height: this.windowState.height,
						x: this.windowState.x,
						y: this.windowState.y
					});
				}
			}

			if (isFullscreenOrMaximized) {
				mark('code/willMaximizeCodeWindow');

				// this call may or may not show the window, depends
				// on the platform: currently on Windows and Linux will
				// show the window as active. To be on the safe side,
				// we show the window at the end of this block.
				this._win.maximize();

				if (this.windowState.mode === WindowMode.Fullscreen) {
					this.setFullScreen(true, true);
				}

				// to reduce flicker from the default window size
				// to maximize or fullscreen, we only show after
				this._win.show();
				mark('code/didMaximizeCodeWindow');
			}

			this._lastFocusTime = Date.now(); // since we show directly, we need to set the last focus time too
		}
		//#endregion

		// respect configured menu bar visibility
		this.onConfigurationUpdated();

		// macOS: touch bar support
		this.createTouchBar();

		// Eventing
		this.registerListeners();
	}

	private readyState = ReadyState.NONE;

	setReady(): void {
		this.logService.trace(`window#load: window reported ready (id: ${this._id})`);

		this.readyState = ReadyState.READY;

		// inform all waiting promises that we are ready now
		while (this.whenReadyCallbacks.length) {
			this.whenReadyCallbacks.pop()!(this);
		}

		// Events
		this._onDidSignalReady.fire();
	}

	ready(): Promise<ICodeWindow> {
		return new Promise<ICodeWindow>(resolve => {
			if (this.isReady) {
				return resolve(this);
			}

			// otherwise keep and call later when we are ready
			this.whenReadyCallbacks.push(resolve);
		});
	}

	get isReady(): boolean {
		return this.readyState === ReadyState.READY;
	}

	get whenClosedOrLoaded(): Promise<void> {
		return new Promise<void>(resolve => {

			function handle() {
				closeListener.dispose();
				loadListener.dispose();

				resolve();
			}

			const closeListener = this.onDidClose(() => handle());
			const loadListener = this.onWillLoad(() => handle());
		});
	}

	private registerListeners(): void {

		// Window error conditions to handle
		this._win.on('unresponsive', () => this.onWindowError(WindowError.UNRESPONSIVE));
		this._win.webContents.on('render-process-gone', (event, details) => this.onWindowError(WindowError.PROCESS_GONE, { ...details }));
		this._win.webContents.on('did-fail-load', (event, exitCode, reason) => this.onWindowError(WindowError.LOAD, { reason, exitCode }));

		// Prevent windows/iframes from blocking the unload
		// through DOM events. We have our own logic for
		// unloading a window that should not be confused
		// with the DOM way.
		// (https://github.com/microsoft/vscode/issues/122736)
		this._win.webContents.on('will-prevent-unload', event => {
			event.preventDefault();
		});

		// Remember that we loaded
		this._win.webContents.on('did-finish-load', () => {

			// Associate properties from the load request if provided
			if (this.pendingLoadConfig) {
				this._config = this.pendingLoadConfig;

				this.pendingLoadConfig = undefined;
			}
		});

		// Window (Un)Maximize
		this._register(this.onDidMaximize(() => {
			if (this._config) {
				this._config.maximized = true;
			}
		}));

		this._register(this.onDidUnmaximize(() => {
			if (this._config) {
				this._config.maximized = false;
			}
		}));

		// Window Fullscreen
		this._register(this.onDidEnterFullScreen(() => {
			this.sendWhenReady('vscode:enterFullScreen', CancellationToken.None);
		}));

		this._register(this.onDidLeaveFullScreen(() => {
			this.sendWhenReady('vscode:leaveFullScreen', CancellationToken.None);
		}));

		// Handle configuration changes
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));

		// Handle Workspace events
		this._register(this.workspacesManagementMainService.onDidDeleteUntitledWorkspace(e => this.onDidDeleteUntitledWorkspace(e)));

		// Inject headers when requests are incoming
		const urls = ['https://marketplace.visualstudio.com/*', 'https://*.vsassets.io/*'];
		this._win.webContents.session.webRequest.onBeforeSendHeaders({ urls }, async (details, cb) => {
			const headers = await this.getMarketplaceHeaders();

			cb({ cancel: false, requestHeaders: Object.assign(details.requestHeaders, headers) });
		});
	}

	private marketplaceHeadersPromise: Promise<object> | undefined;
	private getMarketplaceHeaders(): Promise<object> {
		if (!this.marketplaceHeadersPromise) {
			this.marketplaceHeadersPromise = resolveMarketplaceHeaders(
				this.productService.version,
				this.productService,
				this.environmentMainService,
				this.configurationService,
				this.fileService,
				this.applicationStorageMainService,
				this.telemetryService);
		}

		return this.marketplaceHeadersPromise;
	}

	private async onWindowError(error: WindowError.UNRESPONSIVE): Promise<void>;
	private async onWindowError(error: WindowError.PROCESS_GONE, details: { reason: string; exitCode: number }): Promise<void>;
	private async onWindowError(error: WindowError.LOAD, details: { reason: string; exitCode: number }): Promise<void>;
	private async onWindowError(type: WindowError, details?: { reason?: string; exitCode?: number }): Promise<void> {

		switch (type) {
			case WindowError.PROCESS_GONE:
				this.logService.error(`CodeWindow: renderer process gone (reason: ${details?.reason || '<unknown>'}, code: ${details?.exitCode || '<unknown>'})`);
				break;
			case WindowError.UNRESPONSIVE:
				this.logService.error('CodeWindow: detected unresponsive');
				break;
			case WindowError.LOAD:
				this.logService.error(`CodeWindow: failed to load (reason: ${details?.reason || '<unknown>'}, code: ${details?.exitCode || '<unknown>'})`);
				break;
		}

		// Telemetry
		type WindowErrorClassification = {
			type: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The type of window error to understand the nature of the error better.' };
			reason: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reason of the window error to understand the nature of the error better.' };
			code: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The exit code of the window process to understand the nature of the error better' };
			owner: 'bpasero';
			comment: 'Provides insight into reasons the vscode window had an error.';
		};
		type WindowErrorEvent = {
			type: WindowError;
			reason: string | undefined;
			code: number | undefined;
		};
		this.telemetryService.publicLog2<WindowErrorEvent, WindowErrorClassification>('windowerror', {
			type,
			reason: details?.reason,
			code: details?.exitCode
		});

		// Inform User if non-recoverable
		switch (type) {
			case WindowError.UNRESPONSIVE:
			case WindowError.PROCESS_GONE:

				// If we run extension tests from CLI, we want to signal
				// back this state to the test runner by exiting with a
				// non-zero exit code.
				if (this.isExtensionDevelopmentTestFromCli) {
					this.lifecycleMainService.kill(1);
					return;
				}

				// If we run smoke tests, want to proceed with an orderly
				// shutdown as much as possible by destroying the window
				// and then calling the normal `quit` routine.
				if (this.environmentMainService.args['enable-smoke-test-driver']) {
					await this.destroyWindow(false, false);
					this.lifecycleMainService.quit(); // still allow for an orderly shutdown
					return;
				}

				// Unresponsive
				if (type === WindowError.UNRESPONSIVE) {
					if (this.isExtensionDevelopmentHost || this.isExtensionTestHost || (this._win && this._win.webContents && this._win.webContents.isDevToolsOpened())) {
						// TODO@electron Workaround for https://github.com/microsoft/vscode/issues/56994
						// In certain cases the window can report unresponsiveness because a breakpoint was hit
						// and the process is stopped executing. The most typical cases are:
						// - devtools are opened and debugging happens
						// - window is an extensions development host that is being debugged
						// - window is an extension test development host that is being debugged
						return;
					}

					// Show Dialog
					const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
						type: 'warning',
						buttons: [
							localize({ key: 'reopen', comment: ['&& denotes a mnemonic'] }, "&&Reopen"),
							localize({ key: 'close', comment: ['&& denotes a mnemonic'] }, "&&Close"),
							localize({ key: 'wait', comment: ['&& denotes a mnemonic'] }, "&&Keep Waiting")
						],
						message: localize('appStalled', "The window is not responding"),
						detail: localize('appStalledDetail', "You can reopen or close the window or keep waiting."),
						checkboxLabel: this._config?.workspace ? localize('doNotRestoreEditors', "Don't restore editors") : undefined
					}, this._win);

					// Handle choice
					if (response !== 2 /* keep waiting */) {
						const reopen = response === 0;
						await this.destroyWindow(reopen, checkboxChecked);
					}
				}

				// Process gone
				else if (type === WindowError.PROCESS_GONE) {
					let message: string;
					if (!details) {
						message = localize('appGone', "The window terminated unexpectedly");
					} else {
						message = localize('appGoneDetails', "The window terminated unexpectedly (reason: '{0}', code: '{1}')", details.reason, details.exitCode ?? '<unknown>');
					}

					// Show Dialog
					const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
						type: 'warning',
						buttons: [
							this._config?.workspace ? localize({ key: 'reopen', comment: ['&& denotes a mnemonic'] }, "&&Reopen") : localize({ key: 'newWindow', comment: ['&& denotes a mnemonic'] }, "&&New Window"),
							localize({ key: 'close', comment: ['&& denotes a mnemonic'] }, "&&Close")
						],
						message,
						detail: this._config?.workspace ?
							localize('appGoneDetailWorkspace', "We are sorry for the inconvenience. You can reopen the window to continue where you left off.") :
							localize('appGoneDetailEmptyWindow', "We are sorry for the inconvenience. You can open a new empty window to start again."),
						checkboxLabel: this._config?.workspace ? localize('doNotRestoreEditors', "Don't restore editors") : undefined
					}, this._win);

					// Handle choice
					const reopen = response === 0;
					await this.destroyWindow(reopen, checkboxChecked);
				}
				break;
		}
	}

	private async destroyWindow(reopen: boolean, skipRestoreEditors: boolean): Promise<void> {
		const workspace = this._config?.workspace;

		// check to discard editor state first
		if (skipRestoreEditors && workspace) {
			try {
				const workspaceStorage = this.storageMainService.workspaceStorage(workspace);
				await workspaceStorage.init();
				workspaceStorage.delete('memento/workbench.parts.editor');
				await workspaceStorage.close();
			} catch (error) {
				this.logService.error(error);
			}
		}

		// 'close' event will not be fired on destroy(), so signal crash via explicit event
		this._onDidDestroy.fire();

		try {
			// ask the windows service to open a new fresh window if specified
			if (reopen && this._config) {

				// We have to reconstruct a openable from the current workspace
				let uriToOpen: IWorkspaceToOpen | IFolderToOpen | undefined = undefined;
				let forceEmpty = undefined;
				if (isSingleFolderWorkspaceIdentifier(workspace)) {
					uriToOpen = { folderUri: workspace.uri };
				} else if (isWorkspaceIdentifier(workspace)) {
					uriToOpen = { workspaceUri: workspace.configPath };
				} else {
					forceEmpty = true;
				}

				// Delegate to windows service
				const window = firstOrDefault(await this.windowsMainService.open({
					context: OpenContext.API,
					userEnv: this._config.userEnv,
					cli: {
						...this.environmentMainService.args,
						_: [] // we pass in the workspace to open explicitly via `urisToOpen`
					},
					urisToOpen: uriToOpen ? [uriToOpen] : undefined,
					forceEmpty,
					forceNewWindow: true,
					remoteAuthority: this.remoteAuthority
				}));
				window?.focus();
			}
		} finally {
			// make sure to destroy the window as its renderer process is gone. do this
			// after the code for reopening the window, to prevent the entire application
			// from quitting when the last window closes as a result.
			this._win?.destroy();
		}
	}

	private onDidDeleteUntitledWorkspace(workspace: IWorkspaceIdentifier): void {

		// Make sure to update our workspace config if we detect that it
		// was deleted
		if (this._config?.workspace?.id === workspace.id) {
			this._config.workspace = undefined;
		}
	}

	private onConfigurationUpdated(e?: IConfigurationChangeEvent): void {

		// Menubar
		if (!e || e.affectsConfiguration('window.menuBarVisibility')) {
			const newMenuBarVisibility = this.getMenuBarVisibility();
			if (newMenuBarVisibility !== this.currentMenuBarVisibility) {
				this.currentMenuBarVisibility = newMenuBarVisibility;
				this.setMenuBarVisibility(newMenuBarVisibility);
			}
		}

		// Proxy
		if (!e || e.affectsConfiguration('http.proxy')) {
			let newHttpProxy = (this.configurationService.getValue<string>('http.proxy') || '').trim()
				|| (process.env['https_proxy'] || process.env['HTTPS_PROXY'] || process.env['http_proxy'] || process.env['HTTP_PROXY'] || '').trim() // Not standardized.
				|| undefined;

			if (newHttpProxy?.endsWith('/')) {
				newHttpProxy = newHttpProxy.substr(0, newHttpProxy.length - 1);
			}

			const newNoProxy = (process.env['no_proxy'] || process.env['NO_PROXY'] || '').trim() || undefined; // Not standardized.
			if ((newHttpProxy || '').indexOf('@') === -1 && (newHttpProxy !== this.currentHttpProxy || newNoProxy !== this.currentNoProxy)) {
				this.currentHttpProxy = newHttpProxy;
				this.currentNoProxy = newNoProxy;

				const proxyRules = newHttpProxy || '';
				const proxyBypassRules = newNoProxy ? `${newNoProxy},<local>` : '<local>';
				this.logService.trace(`Setting proxy to '${proxyRules}', bypassing '${proxyBypassRules}'`);
				this._win.webContents.session.setProxy({ proxyRules, proxyBypassRules, pacScript: '' });
			}
		}
	}

	addTabbedWindow(window: ICodeWindow): void {
		if (isMacintosh && window.win) {
			this._win.addTabbedWindow(window.win);
		}
	}

	load(configuration: INativeWindowConfiguration, options: ILoadOptions = Object.create(null)): void {
		this.logService.trace(`window#load: attempt to load window (id: ${this._id})`);

		// Clear Document Edited if needed
		if (this.isDocumentEdited()) {
			if (!options.isReload || !this.backupMainService.isHotExitEnabled()) {
				this.setDocumentEdited(false);
			}
		}

		// Clear Title and Filename if needed
		if (!options.isReload) {
			if (this.getRepresentedFilename()) {
				this.setRepresentedFilename('');
			}

			this._win.setTitle(this.productService.nameLong);
		}

		// Update configuration values based on our window context
		// and set it into the config object URL for usage.
		this.updateConfiguration(configuration, options);

		// If this is the first time the window is loaded, we associate the paths
		// directly with the window because we assume the loading will just work
		if (this.readyState === ReadyState.NONE) {
			this._config = configuration;
		}

		// Otherwise, the window is currently showing a folder and if there is an
		// unload handler preventing the load, we cannot just associate the paths
		// because the loading might be vetoed. Instead we associate it later when
		// the window load event has fired.
		else {
			this.pendingLoadConfig = configuration;
		}

		// Indicate we are navigting now
		this.readyState = ReadyState.NAVIGATING;

		// Load URL
		this._win.loadURL(FileAccess.asBrowserUri(`vs/code/electron-sandbox/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true));

		// Remember that we did load
		const wasLoaded = this.wasLoaded;
		this.wasLoaded = true;

		// Make window visible if it did not open in N seconds because this indicates an error
		// Only do this when running out of sources and not when running tests
		if (!this.environmentMainService.isBuilt && !this.environmentMainService.extensionTestsLocationURI) {
			this._register(new RunOnceScheduler(() => {
				if (this._win && !this._win.isVisible() && !this._win.isMinimized()) {
					this._win.show();
					this.focus({ force: true });
					this._win.webContents.openDevTools();
				}
			}, 10000)).schedule();
		}

		// Event
		this._onWillLoad.fire({ workspace: configuration.workspace, reason: options.isReload ? LoadReason.RELOAD : wasLoaded ? LoadReason.LOAD : LoadReason.INITIAL });
	}

	private updateConfiguration(configuration: INativeWindowConfiguration, options: ILoadOptions): void {

		// If this window was loaded before from the command line
		// (as indicated by VSCODE_CLI environment), make sure to
		// preserve that user environment in subsequent loads,
		// unless the new configuration context was also a CLI
		// (for https://github.com/microsoft/vscode/issues/108571)
		// Also, preserve the environment if we're loading from an
		// extension development host that had its environment set
		// (for https://github.com/microsoft/vscode/issues/123508)
		const currentUserEnv = (this._config ?? this.pendingLoadConfig)?.userEnv;
		if (currentUserEnv) {
			const shouldPreserveLaunchCliEnvironment = isLaunchedFromCli(currentUserEnv) && !isLaunchedFromCli(configuration.userEnv);
			const shouldPreserveDebugEnvironmnet = this.isExtensionDevelopmentHost;
			if (shouldPreserveLaunchCliEnvironment || shouldPreserveDebugEnvironmnet) {
				configuration.userEnv = { ...currentUserEnv, ...configuration.userEnv }; // still allow to override certain environment as passed in
			}
		}

		// If named pipe was instantiated for the crashpad_handler process, reuse the same
		// pipe for new app instances connecting to the original app instance.
		// Ref: https://github.com/microsoft/vscode/issues/115874
		if (process.env['CHROME_CRASHPAD_PIPE_NAME']) {
			Object.assign(configuration.userEnv, {
				CHROME_CRASHPAD_PIPE_NAME: process.env['CHROME_CRASHPAD_PIPE_NAME']
			});
		}

		// Add disable-extensions to the config, but do not preserve it on currentConfig or
		// pendingLoadConfig so that it is applied only on this load
		if (options.disableExtensions !== undefined) {
			configuration['disable-extensions'] = options.disableExtensions;
		}

		// Update window related properties
		configuration.fullscreen = this.isFullScreen;
		configuration.maximized = this._win.isMaximized();
		configuration.partsSplash = this.themeMainService.getWindowSplash();
		configuration.zoomLevel = this.getZoomLevel();
		configuration.isCustomZoomLevel = typeof this.customZoomLevel === 'number';
		if (configuration.isCustomZoomLevel && configuration.partsSplash) {
			configuration.partsSplash.zoomLevel = configuration.zoomLevel;
		}

		// Update with latest perf marks
		mark('code/willOpenNewWindow');
		configuration.perfMarks = getMarks();

		// Update in config object URL for usage in renderer
		this.configObjectUrl.update(configuration);
	}

	async reload(cli?: NativeParsedArgs): Promise<void> {

		// Copy our current config for reuse
		const configuration = Object.assign({}, this._config);

		// Validate workspace
		configuration.workspace = await this.validateWorkspaceBeforeReload(configuration);

		// Delete some properties we do not want during reload
		delete configuration.filesToOpenOrCreate;
		delete configuration.filesToDiff;
		delete configuration.filesToMerge;
		delete configuration.filesToWait;

		// Some configuration things get inherited if the window is being reloaded and we are
		// in extension development mode. These options are all development related.
		if (this.isExtensionDevelopmentHost && cli) {
			configuration.verbose = cli.verbose;
			configuration.debugId = cli.debugId;
			configuration.extensionEnvironment = cli.extensionEnvironment;
			configuration['inspect-extensions'] = cli['inspect-extensions'];
			configuration['inspect-brk-extensions'] = cli['inspect-brk-extensions'];
			configuration['extensions-dir'] = cli['extensions-dir'];
		}

		configuration.accessibilitySupport = app.isAccessibilitySupportEnabled();
		configuration.isInitialStartup = false; // since this is a reload
		configuration.policiesData = this.policyService.serialize(); // set policies data again
		configuration.continueOn = this.environmentMainService.continueOn;
		configuration.profiles = {
			all: this.userDataProfilesService.profiles,
			profile: this.profile || this.userDataProfilesService.defaultProfile,
			home: this.userDataProfilesService.profilesHome
		};
		configuration.logLevel = this.loggerMainService.getLogLevel();
		configuration.loggers = {
			window: this.loggerMainService.getRegisteredLoggers(this.id),
			global: this.loggerMainService.getRegisteredLoggers()
		};

		// Load config
		this.load(configuration, { isReload: true, disableExtensions: cli?.['disable-extensions'] });
	}

	private async validateWorkspaceBeforeReload(configuration: INativeWindowConfiguration): Promise<IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined> {

		// Multi folder
		if (isWorkspaceIdentifier(configuration.workspace)) {
			const configPath = configuration.workspace.configPath;
			if (configPath.scheme === Schemas.file) {
				const workspaceExists = await this.fileService.exists(configPath);
				if (!workspaceExists) {
					return undefined;
				}
			}
		}

		// Single folder
		else if (isSingleFolderWorkspaceIdentifier(configuration.workspace)) {
			const uri = configuration.workspace.uri;
			if (uri.scheme === Schemas.file) {
				const folderExists = await this.fileService.exists(uri);
				if (!folderExists) {
					return undefined;
				}
			}
		}

		// Workspace is valid
		return configuration.workspace;
	}

	serializeWindowState(): IWindowState {
		if (!this._win) {
			return defaultWindowState();
		}

		// fullscreen gets special treatment
		if (this.isFullScreen) {
			let display: Display | undefined;
			try {
				display = screen.getDisplayMatching(this.getBounds());
			} catch (error) {
				// Electron has weird conditions under which it throws errors
				// e.g. https://github.com/microsoft/vscode/issues/100334 when
				// large numbers are passed in
			}

			const defaultState = defaultWindowState();

			return {
				mode: WindowMode.Fullscreen,
				display: display ? display.id : undefined,

				// Still carry over window dimensions from previous sessions
				// if we can compute it in fullscreen state.
				// does not seem possible in all cases on Linux for example
				// (https://github.com/microsoft/vscode/issues/58218) so we
				// fallback to the defaults in that case.
				width: this.windowState.width || defaultState.width,
				height: this.windowState.height || defaultState.height,
				x: this.windowState.x || 0,
				y: this.windowState.y || 0,
				zoomLevel: this.customZoomLevel
			};
		}

		const state: IWindowState = Object.create(null);
		let mode: WindowMode;

		// get window mode
		if (!isMacintosh && this._win.isMaximized()) {
			mode = WindowMode.Maximized;
		} else {
			mode = WindowMode.Normal;
		}

		// we don't want to save minimized state, only maximized or normal
		if (mode === WindowMode.Maximized) {
			state.mode = WindowMode.Maximized;
		} else {
			state.mode = WindowMode.Normal;
		}

		// only consider non-minimized window states
		if (mode === WindowMode.Normal || mode === WindowMode.Maximized) {
			let bounds: Rectangle;
			if (mode === WindowMode.Normal) {
				bounds = this.getBounds();
			} else {
				bounds = this._win.getNormalBounds(); // make sure to persist the normal bounds when maximized to be able to restore them
			}

			state.x = bounds.x;
			state.y = bounds.y;
			state.width = bounds.width;
			state.height = bounds.height;
		}

		state.zoomLevel = this.customZoomLevel;

		return state;
	}

	private restoreWindowState(state?: IWindowState): [IWindowState, boolean? /* has multiple displays */] {
		mark('code/willRestoreCodeWindowState');

		let hasMultipleDisplays = false;
		if (state) {

			// Window zoom
			this.customZoomLevel = state.zoomLevel;

			// Window dimensions
			try {
				const displays = screen.getAllDisplays();
				hasMultipleDisplays = displays.length > 1;

				state = WindowStateValidator.validateWindowState(this.logService, state, displays);
			} catch (err) {
				this.logService.warn(`Unexpected error validating window state: ${err}\n${err.stack}`); // somehow display API can be picky about the state to validate
			}
		}

		mark('code/didRestoreCodeWindowState');

		return [state || defaultWindowState(), hasMultipleDisplays];
	}

	getBounds(): Rectangle {
		const [x, y] = this._win.getPosition();
		const [width, height] = this._win.getSize();

		return { x, y, width, height };
	}

	protected override setFullScreen(fullscreen: boolean, fromRestore: boolean): void {
		super.setFullScreen(fullscreen, fromRestore);

		// Events
		this.sendWhenReady(fullscreen ? 'vscode:enterFullScreen' : 'vscode:leaveFullScreen', CancellationToken.None);

		// Respect configured menu bar visibility or default to toggle if not set
		if (this.currentMenuBarVisibility) {
			this.setMenuBarVisibility(this.currentMenuBarVisibility, false);
		}
	}

	private getMenuBarVisibility(): MenuBarVisibility {
		let menuBarVisibility = getMenuBarVisibility(this.configurationService);
		if (['visible', 'toggle', 'hidden'].indexOf(menuBarVisibility) < 0) {
			menuBarVisibility = 'classic';
		}

		return menuBarVisibility;
	}

	private setMenuBarVisibility(visibility: MenuBarVisibility, notify: boolean = true): void {
		if (isMacintosh) {
			return; // ignore for macOS platform
		}

		if (visibility === 'toggle') {
			if (notify) {
				this.send('vscode:showInfoMessage', localize('hiddenMenuBar', "You can still access the menu bar by pressing the Alt-key."));
			}
		}

		if (visibility === 'hidden') {
			// for some weird reason that I have no explanation for, the menu bar is not hiding when calling
			// this without timeout (see https://github.com/microsoft/vscode/issues/19777). there seems to be
			// a timing issue with us opening the first window and the menu bar getting created. somehow the
			// fact that we want to hide the menu without being able to bring it back via Alt key makes Electron
			// still show the menu. Unable to reproduce from a simple Hello World application though...
			setTimeout(() => {
				this.doSetMenuBarVisibility(visibility);
			});
		} else {
			this.doSetMenuBarVisibility(visibility);
		}
	}

	private doSetMenuBarVisibility(visibility: MenuBarVisibility): void {
		const isFullscreen = this.isFullScreen;

		switch (visibility) {
			case ('classic'):
				this._win.setMenuBarVisibility(!isFullscreen);
				this._win.autoHideMenuBar = isFullscreen;
				break;

			case ('visible'):
				this._win.setMenuBarVisibility(true);
				this._win.autoHideMenuBar = false;
				break;

			case ('toggle'):
				this._win.setMenuBarVisibility(false);
				this._win.autoHideMenuBar = true;
				break;

			case ('hidden'):
				this._win.setMenuBarVisibility(false);
				this._win.autoHideMenuBar = false;
				break;
		}
	}

	notifyZoomLevel(zoomLevel: number | undefined): void {
		this.customZoomLevel = zoomLevel;
	}

	private getZoomLevel(): number | undefined {
		if (typeof this.customZoomLevel === 'number') {
			return this.customZoomLevel;
		}

		const windowSettings = this.configurationService.getValue<IWindowSettings | undefined>('window');
		return windowSettings?.zoomLevel;
	}

	close(): void {
		this._win?.close();
	}

	sendWhenReady(channel: string, token: CancellationToken, ...args: any[]): void {
		if (this.isReady) {
			this.send(channel, ...args);
		} else {
			this.ready().then(() => {
				if (!token.isCancellationRequested) {
					this.send(channel, ...args);
				}
			});
		}
	}

	send(channel: string, ...args: any[]): void {
		if (this._win) {
			if (this._win.isDestroyed() || this._win.webContents.isDestroyed()) {
				this.logService.warn(`Sending IPC message to channel '${channel}' for window that is destroyed`);
				return;
			}

			try {
				this._win.webContents.send(channel, ...args);
			} catch (error) {
				this.logService.warn(`Error sending IPC message to channel '${channel}' of window ${this._id}: ${toErrorMessage(error)}`);
			}
		}
	}

	updateTouchBar(groups: ISerializableCommandAction[][]): void {
		if (!isMacintosh) {
			return; // only supported on macOS
		}

		// Update segments for all groups. Setting the segments property
		// of the group directly prevents ugly flickering from happening
		this.touchBarGroups.forEach((touchBarGroup, index) => {
			const commands = groups[index];
			touchBarGroup.segments = this.createTouchBarGroupSegments(commands);
		});
	}

	private createTouchBar(): void {
		if (!isMacintosh) {
			return; // only supported on macOS
		}

		// To avoid flickering, we try to reuse the touch bar group
		// as much as possible by creating a large number of groups
		// for reusing later.
		for (let i = 0; i < 10; i++) {
			const groupTouchBar = this.createTouchBarGroup();
			this.touchBarGroups.push(groupTouchBar);
		}

		this._win.setTouchBar(new TouchBar({ items: this.touchBarGroups }));
	}

	private createTouchBarGroup(items: ISerializableCommandAction[] = []): TouchBarSegmentedControl {

		// Group Segments
		const segments = this.createTouchBarGroupSegments(items);

		// Group Control
		const control = new TouchBar.TouchBarSegmentedControl({
			segments,
			mode: 'buttons',
			segmentStyle: 'automatic',
			change: (selectedIndex) => {
				this.sendWhenReady('vscode:runAction', CancellationToken.None, { id: (control.segments[selectedIndex] as ITouchBarSegment).id, from: 'touchbar' });
			}
		});

		return control;
	}

	private createTouchBarGroupSegments(items: ISerializableCommandAction[] = []): ITouchBarSegment[] {
		const segments: ITouchBarSegment[] = items.map(item => {
			let icon: NativeImage | undefined;
			if (item.icon && !ThemeIcon.isThemeIcon(item.icon) && item.icon?.dark?.scheme === Schemas.file) {
				icon = nativeImage.createFromPath(URI.revive(item.icon.dark).fsPath);
				if (icon.isEmpty()) {
					icon = undefined;
				}
			}

			let title: string;
			if (typeof item.title === 'string') {
				title = item.title;
			} else {
				title = item.title.value;
			}

			return {
				id: item.id,
				label: !icon ? title : undefined,
				icon
			};
		});

		return segments;
	}

	override dispose(): void {
		super.dispose();

		// Deregister the loggers for this window
		this.loggerMainService.deregisterLoggers(this.id);
	}
}

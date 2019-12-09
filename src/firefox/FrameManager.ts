/**
 * Copyright 2019 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import { TimeoutError } from '../Errors';
import * as frames from '../frames';
import { assert, helper, RegisteredListener, debugError } from '../helper';
import * as js from '../javascript';
import * as dom from '../dom';
import { TimeoutSettings } from '../TimeoutSettings';
import { JugglerSession } from './Connection';
import { ExecutionContextDelegate } from './ExecutionContext';
import { NavigationWatchdog, NextNavigationWatchdog } from './NavigationWatchdog';
import { Page } from './Page';
import { NetworkManager } from './NetworkManager';
import { DOMWorldDelegate } from './JSHandle';
import { Events } from './events';
import * as dialog from '../dialog';
import { Protocol } from './protocol';

export const FrameManagerEvents = {
  FrameNavigated: Symbol('FrameManagerEvents.FrameNavigated'),
  FrameAttached: Symbol('FrameManagerEvents.FrameAttached'),
  FrameDetached: Symbol('FrameManagerEvents.FrameDetached'),
  Load: Symbol('FrameManagerEvents.Load'),
  DOMContentLoaded: Symbol('FrameManagerEvents.DOMContentLoaded'),
};

const frameDataSymbol = Symbol('frameData');
type FrameData = {
  frameId: string,
  lastCommittedNavigationId: string,
  firedEvents: Set<string>,
};

export class FrameManager extends EventEmitter implements frames.FrameDelegate {
  _session: JugglerSession;
  _page: Page;
  _networkManager: NetworkManager;
  _timeoutSettings: TimeoutSettings;
  _mainFrame: frames.Frame;
  _frames: Map<string, frames.Frame>;
  _contextIdToContext: Map<string, js.ExecutionContext>;
  _eventListeners: RegisteredListener[];

  constructor(session: JugglerSession, page: Page, networkManager, timeoutSettings) {
    super();
    this._session = session;
    this._page = page;
    this._networkManager = networkManager;
    this._timeoutSettings = timeoutSettings;
    this._mainFrame = null;
    this._frames = new Map();
    this._contextIdToContext = new Map();
    this._eventListeners = [
      helper.addEventListener(this._session, 'Page.eventFired', this._onEventFired.bind(this)),
      helper.addEventListener(this._session, 'Page.frameAttached', this._onFrameAttached.bind(this)),
      helper.addEventListener(this._session, 'Page.frameDetached', this._onFrameDetached.bind(this)),
      helper.addEventListener(this._session, 'Page.navigationCommitted', this._onNavigationCommitted.bind(this)),
      helper.addEventListener(this._session, 'Page.sameDocumentNavigation', this._onSameDocumentNavigation.bind(this)),
      helper.addEventListener(this._session, 'Runtime.executionContextCreated', this._onExecutionContextCreated.bind(this)),
      helper.addEventListener(this._session, 'Runtime.executionContextDestroyed', this._onExecutionContextDestroyed.bind(this)),
      helper.addEventListener(this._session, 'Page.uncaughtError', this._onUncaughtError.bind(this)),
      helper.addEventListener(this._session, 'Runtime.console', this._onConsole.bind(this)),
      helper.addEventListener(this._session, 'Page.dialogOpened', this._onDialogOpened.bind(this)),
      helper.addEventListener(this._session, 'Page.bindingCalled', this._onBindingCalled.bind(this)),
      helper.addEventListener(this._session, 'Page.fileChooserOpened', this._onFileChooserOpened.bind(this)),
    ];
  }

  async _initialize() {
    await Promise.all([
      this._session.send('Runtime.enable'),
      this._session.send('Network.enable'),
      this._session.send('Page.enable'),
      this._session.send('Page.setInterceptFileChooserDialog', { enabled: true })
    ]);
  }

  executionContextById(executionContextId) {
    return this._contextIdToContext.get(executionContextId) || null;
  }

  _onExecutionContextCreated({executionContextId, auxData}) {
    const frameId = auxData ? auxData.frameId : null;
    const frame = this._frames.get(frameId) || null;
    const context = new js.ExecutionContext(new ExecutionContextDelegate(this._session, executionContextId));
    if (frame) {
      context._domWorld = new dom.DOMWorld(context, new DOMWorldDelegate(this, frame));
      frame._contextCreated('main', context);
      frame._contextCreated('utility', context);
    }
    this._contextIdToContext.set(executionContextId, context);
  }

  _onExecutionContextDestroyed({executionContextId}) {
    const context = this._contextIdToContext.get(executionContextId);
    if (!context)
      return;
    this._contextIdToContext.delete(executionContextId);
    if (context.frame())
      context.frame()._contextDestroyed(context);
  }

  _frameData(frame: frames.Frame): FrameData {
    return (frame as any)[frameDataSymbol];
  }

  frame(frameId: string): frames.Frame {
    return this._frames.get(frameId);
  }

  mainFrame(): frames.Frame {
    return this._mainFrame;
  }

  frames() {
    const frames: Array<frames.Frame> = [];
    collect(this._mainFrame);
    return frames;

    function collect(frame: frames.Frame) {
      frames.push(frame);
      for (const subframe of frame.childFrames())
        collect(subframe);
    }
  }

  _onNavigationCommitted(params) {
    const frame = this._frames.get(params.frameId);
    frame._navigated(params.url, params.name);
    const data = this._frameData(frame);
    data.lastCommittedNavigationId = params.navigationId;
    data.firedEvents.clear();
    this.emit(FrameManagerEvents.FrameNavigated, frame);
  }

  _onSameDocumentNavigation(params) {
    const frame = this._frames.get(params.frameId);
    frame._navigated(params.url, frame.name());
    this.emit(FrameManagerEvents.FrameNavigated, frame);
  }

  _onFrameAttached(params) {
    const parentFrame = this._frames.get(params.parentFrameId) || null;
    const frame = new frames.Frame(this, this._timeoutSettings, parentFrame);
    const data: FrameData = {
      frameId: params.frameId,
      lastCommittedNavigationId: '',
      firedEvents: new Set(),
    };
    frame[frameDataSymbol] = data;
    if (!parentFrame) {
      assert(!this._mainFrame, 'INTERNAL ERROR: re-attaching main frame!');
      this._mainFrame = frame;
    }
    this._frames.set(params.frameId, frame);
    this.emit(FrameManagerEvents.FrameAttached, frame);
  }

  _onFrameDetached(params) {
    const frame = this._frames.get(params.frameId);
    this._frames.delete(params.frameId);
    frame._detach();
    this.emit(FrameManagerEvents.FrameDetached, frame);
  }

  _onEventFired({frameId, name}) {
    const frame = this._frames.get(frameId);
    this._frameData(frame).firedEvents.add(name.toLowerCase());
    if (frame === this._mainFrame) {
      if (name === 'load')
        this.emit(FrameManagerEvents.Load);
      else if (name === 'DOMContentLoaded')
        this.emit(FrameManagerEvents.DOMContentLoaded);
    }
  }

  _onUncaughtError(params) {
    const error = new Error(params.message);
    error.stack = params.stack;
    this._page.emit(Events.Page.PageError, error);
  }

  _onConsole({type, args, executionContextId, location}) {
    const context = this.executionContextById(executionContextId);
    this._page._addConsoleMessage(type, args.map(arg => context._createHandle(arg)), location);
  }

  _onDialogOpened(params) {
    this._page.emit(Events.Page.Dialog, new dialog.Dialog(
      params.type as dialog.DialogType,
      params.message,
      async (accept: boolean, promptText?: string) => {
        await this._session.send('Page.handleDialog', { dialogId: params.dialogId, accept, promptText }).catch(debugError);
      },
      params.defaultValue));
  }

  _onBindingCalled(event: Protocol.Page.bindingCalledPayload) {
    const context = this.executionContextById(event.executionContextId);
    this._page._onBindingCalled(event.payload, context);
  }

  async _onFileChooserOpened({executionContextId, element}) {
    const context = this.executionContextById(executionContextId);
    const handle = context._createHandle(element).asElement()!;
    this._page._onFileChooserOpened(handle);
  }

  async _exposeBinding(name: string, bindingFunction: string) {
    await this._session.send('Page.addBinding', {name: name});
    await this._session.send('Page.addScriptToEvaluateOnNewDocument', {script: bindingFunction});
    await Promise.all(this.frames().map(frame => frame.evaluate(bindingFunction).catch(debugError)));
  }

  dispose() {
    helper.removeEventListeners(this._eventListeners);
  }

  async waitForFrameNavigation(frame: frames.Frame, options: { timeout?: number; waitUntil?: string | Array<string>; } = {}) {
    const {
      timeout = this._timeoutSettings.navigationTimeout(),
      waitUntil = ['load'],
    } = options;
    const normalizedWaitUntil = normalizeWaitUntil(waitUntil);

    const timeoutError = new TimeoutError('Navigation timeout of ' + timeout + ' ms exceeded');
    let timeoutCallback;
    const timeoutPromise = new Promise(resolve => timeoutCallback = resolve.bind(null, timeoutError));
    const timeoutId = timeout ? setTimeout(timeoutCallback, timeout) : null;

    const nextNavigationDog = new NextNavigationWatchdog(this, frame);
    const error1 = await Promise.race([
      nextNavigationDog.promise(),
      timeoutPromise,
    ]);
    nextNavigationDog.dispose();

    // If timeout happened first - throw.
    if (error1) {
      clearTimeout(timeoutId);
      throw error1;
    }

    const {navigationId, url} = nextNavigationDog.navigation();

    if (!navigationId) {
      // Same document navigation happened.
      clearTimeout(timeoutId);
      return null;
    }

    const watchDog = new NavigationWatchdog(this, frame, this._networkManager, navigationId, url, normalizedWaitUntil);
    const error = await Promise.race([
      timeoutPromise,
      watchDog.promise(),
    ]);
    watchDog.dispose();
    clearTimeout(timeoutId);
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  async navigateFrame(frame: frames.Frame, url: string, options: { timeout?: number; waitUntil?: string | Array<string>; referer?: string; } = {}) {
    const {
      timeout = this._timeoutSettings.navigationTimeout(),
      waitUntil = ['load'],
      referer,
    } = options;
    const normalizedWaitUntil = normalizeWaitUntil(waitUntil);
    const {navigationId} = await this._session.send('Page.navigate', {
      frameId: this._frameData(frame).frameId,
      referer,
      url,
    });
    if (!navigationId)
      return;

    const timeoutError = new TimeoutError('Navigation timeout of ' + timeout + ' ms exceeded');
    let timeoutCallback;
    const timeoutPromise = new Promise(resolve => timeoutCallback = resolve.bind(null, timeoutError));
    const timeoutId = timeout ? setTimeout(timeoutCallback, timeout) : null;

    const watchDog = new NavigationWatchdog(this, frame, this._networkManager, navigationId, url, normalizedWaitUntil);
    const error = await Promise.race([
      timeoutPromise,
      watchDog.promise(),
    ]);
    watchDog.dispose();
    clearTimeout(timeoutId);
    if (error)
      throw error;
    return watchDog.navigationResponse();
  }

  async setFrameContent(frame: frames.Frame, html: string) {
    const context = await frame._utilityContext();
    await context.evaluate(html => {
      document.open();
      document.write(html);
      document.close();
    }, html);
  }
}

export function normalizeWaitUntil(waitUntil) {
  if (!Array.isArray(waitUntil))
    waitUntil = [waitUntil];
  for (const condition of waitUntil) {
    if (condition !== 'load' && condition !== 'domcontentloaded')
      throw new Error('Unknown waitUntil condition: ' + condition);
  }
  return waitUntil;
}

/*!
 * Copyright (c) 2015-present, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 */
/* eslint-disable complexity */
/* eslint-disable max-statements */
/* SDK_VERSION is defined in webpack config */ 
/* global SDK_VERSION */

import OktaAuthBase from '../OktaAuthBase';
import * as features from './features';
import fetchRequest from '../fetch/fetchRequest';
import browserStorage from './browserStorage';
import { removeTrailingSlash, toQueryParams, clone } from '../util';
import { getUserAgent } from '../builderUtil';
import { DEFAULT_MAX_CLOCK_SKEW, ACCESS_TOKEN_STORAGE_KEY, ID_TOKEN_STORAGE_KEY } from '../constants';
import {
  closeSession,
  sessionExists,
  getSession,
  refreshSession,
  setCookieAndRedirect
} from '../session';
import {
  getWithoutPrompt,
  getWithPopup,
  getWithRedirect,
  parseFromUrl,
  decodeToken,
  revokeToken,
  renewToken,
  getUserInfo,
  verifyToken
} from '../token';
import { TokenManager } from '../TokenManager';
import {
  getOAuthUrls,
  isLoginRedirect
} from '../oauthUtil';
import http from '../http';
import PromiseQueue from '../PromiseQueue';
import { OktaAuth, OktaAuthOptions, AccessToken, TokenAPI, FeaturesAPI, SignoutAPI, FingerprintAPI } from '../types';
import fingerprint from './fingerprint';
import { postToTransaction } from '../tx';

const Emitter = require('tiny-emitter');

class OktaAuthBrowser extends OktaAuthBase implements OktaAuth, SignoutAPI {
  static features: FeaturesAPI;
  features: FeaturesAPI;
  token: TokenAPI;
  _tokenQueue: PromiseQueue;
  emitter: typeof Emitter;
  tokenManager: TokenManager;
  fingerprint: FingerprintAPI;

  constructor(args: OktaAuthOptions) {
    args = Object.assign({
      httpRequestClient: fetchRequest,
      storageUtil: browserStorage
    }, args);
    super(args);

    var cookieSettings = Object.assign({
      secure: true
    }, args.cookies);
    var isLocalhost = (this.features.isLocalhost() && !this.features.isHTTPS());
    if (isLocalhost) {
      cookieSettings.secure = false; // Force secure=false if running on http://localhost
    }
    if (typeof cookieSettings.sameSite === 'undefined') {
      // Chrome >= 80 will block cookies with SameSite=None unless they are also Secure
      cookieSettings.sameSite = cookieSettings.secure ? 'none' : 'lax';
    }
    if (cookieSettings.secure && !this.features.isHTTPS()) {
      // eslint-disable-next-line no-console
      console.warn(
        'The current page is not being served with the HTTPS protocol.\n' +
        'For security reasons, we strongly recommend using HTTPS.\n' +
        'If you cannot use HTTPS, set "cookies.secure" option to false.'
      );
      cookieSettings.secure = false;
    }
  
    this.options = Object.assign(this.options, {
      clientId: args.clientId,
      authorizeUrl: removeTrailingSlash(args.authorizeUrl),
      userinfoUrl: removeTrailingSlash(args.userinfoUrl),
      tokenUrl: removeTrailingSlash(args.tokenUrl),
      revokeUrl: removeTrailingSlash(args.revokeUrl),
      logoutUrl: removeTrailingSlash(args.logoutUrl),
      pkce: args.pkce === false ? false : true,
      redirectUri: args.redirectUri,
      postLogoutRedirectUri: args.postLogoutRedirectUri,
      responseMode: args.responseMode,
      transformErrorXHR: args.transformErrorXHR,
      cookies: cookieSettings
    });
  
    this.userAgent = getUserAgent(args, `okta-auth-js/${SDK_VERSION}`);
  
    // Digital clocks will drift over time, so the server
    // can misalign with the time reported by the browser.
    // The maxClockSkew allows relaxing the time-based
    // validation of tokens (in seconds, not milliseconds).
    // It currently defaults to 300, because 5 min is the
    // default maximum tolerance allowed by Kerberos.
    // (https://technet.microsoft.com/en-us/library/cc976357.aspx)
    if (!args.maxClockSkew && args.maxClockSkew !== 0) {
      this.options.maxClockSkew = DEFAULT_MAX_CLOCK_SKEW;
    } else {
      this.options.maxClockSkew = args.maxClockSkew;
    }
  
    // Give the developer the ability to disable token signature
    // validation.
    this.options.ignoreSignature = !!args.ignoreSignature;

    this.session = {
      close: closeSession.bind(null, this),
      exists: sessionExists.bind(null, this),
      get: getSession.bind(null, this),
      refresh: refreshSession.bind(null, this),
      setCookieAndRedirect: setCookieAndRedirect.bind(null, this)
    };

    this._tokenQueue = new PromiseQueue();
    this.token = {
      getWithoutPrompt: getWithoutPrompt.bind(null, this),
      getWithPopup: getWithPopup.bind(null, this),
      getWithRedirect: getWithRedirect.bind(null, this),
      parseFromUrl: parseFromUrl.bind(null, this),
      decode: decodeToken,
      revoke: revokeToken.bind(null, this),
      renew: renewToken.bind(null, this),
      getUserInfo: getUserInfo.bind(null, this),
      verify: verifyToken.bind(null, this),
      isLoginRedirect: isLoginRedirect.bind(null, this)
    };
    // Wrap all async token API methods using MethodQueue to avoid issues with concurrency
    const syncMethods = ['decode', 'isLoginRedirect'];
    Object.keys(this.token).forEach(key => {
      if (syncMethods.indexOf(key) >= 0) { // sync methods should not be wrapped
        return;
      }
      var method = this.token[key];
      this.token[key] = PromiseQueue.prototype.push.bind(this._tokenQueue, method, null);
    });
    
    Object.assign(this.token.getWithRedirect, {
      // This is exposed so we can set window.location in our tests
      _setLocation: function(url) {
        window.location = url;
      }
    });
    Object.assign(this.token.parseFromUrl, {
      // This is exposed so we can mock getting window.history in our tests
      _getHistory: function() {
        return window.history;
      },

      // This is exposed so we can mock getting window.location in our tests
      _getLocation: function() {
        return window.location;
      },

      // This is exposed so we can mock getting window.document in our tests
      _getDocument: function() {
        return window.document;
      }
    });

    // Fingerprint API
    this.fingerprint = fingerprint.bind(null, this);
    

    this.emitter = new Emitter();
    this.tokenManager = new TokenManager(this, args.tokenManager);
  }

  signIn(opts) {
    opts = clone(opts || {});
    const _postToTransaction = (options?) => {
      delete opts.sendFingerprint;
      return postToTransaction(this, '/api/v1/authn', opts, options);
    };
    if (!opts.sendFingerprint) {
      return _postToTransaction();
    }
    return this.fingerprint()
    .then(function(fingerprint) {
      return _postToTransaction({
        headers: {
          'X-Device-Fingerprint': fingerprint
        }
      });
    });
  }
  
  // Ends the current Okta SSO session without redirecting to Okta.
  closeSession() {
    // Clear all local tokens
    this.tokenManager.clear();
  
    return this.session.close() // DELETE /api/v1/sessions/me
    .catch(function(e) {
      if (e.name === 'AuthApiError' && e.errorCode === 'E0000007') {
        // Session does not exist or has already been closed
        return;
      }
      throw e;
    });
  }
  
  // Revokes the access token for the application session
  async revokeAccessToken(accessToken?: AccessToken) {
    if (!accessToken) {
      accessToken = await this.tokenManager.get(ACCESS_TOKEN_STORAGE_KEY) as AccessToken;
      this.tokenManager.remove(ACCESS_TOKEN_STORAGE_KEY);
    }
    // Access token may have been removed. In this case, we will silently succeed.
    if (!accessToken) {
      return Promise.resolve();
    }
    return this.token.revoke(accessToken);
  }
  
  // Revokes accessToken, clears all local tokens, then redirects to Okta to end the SSO session.
  async signOut(options?) {
    options = Object.assign({}, options);
  
    // postLogoutRedirectUri must be whitelisted in Okta Admin UI
    var defaultUri = window.location.origin;
    var currentUri = window.location.href;
    var postLogoutRedirectUri = options.postLogoutRedirectUri
      || this.options.postLogoutRedirectUri
      || defaultUri;
  
    var accessToken = options.accessToken;
    var revokeAccessToken = options.revokeAccessToken !== false;
    var idToken = options.idToken;
  
    var logoutUrl = getOAuthUrls(this).logoutUrl;
  
    if (typeof idToken === 'undefined') {
      idToken = await this.tokenManager.get(ID_TOKEN_STORAGE_KEY);
    }
  
    if (revokeAccessToken && typeof accessToken === 'undefined') {
      accessToken = await this.tokenManager.get(ACCESS_TOKEN_STORAGE_KEY);
    }
  
    // Clear all local tokens
    this.tokenManager.clear();
  
    if (revokeAccessToken && accessToken) {
      await this.revokeAccessToken(accessToken);
    }
  
    // No idToken? This can happen if the storage was cleared.
    // Fallback to XHR signOut, then simulate a redirect to the post logout uri
    if (!idToken) {
      return this.closeSession() // can throw if the user cannot be signed out
      .then(function() {
        if (postLogoutRedirectUri === currentUri) {
          window.location.reload(); // force a hard reload if URI is not changing
        } else {
          window.location.assign(postLogoutRedirectUri);
        }
      });
    }
  
    // logout redirect using the idToken.
    var state = options.state;
    var idTokenHint = idToken.idToken; // a string
    var logoutUri = logoutUrl + '?id_token_hint=' + encodeURIComponent(idTokenHint) +
      '&post_logout_redirect_uri=' + encodeURIComponent(postLogoutRedirectUri);
  
    // State allows option parameters to be passed to logout redirect uri
    if (state) {
      logoutUri += '&state=' + encodeURIComponent(state);
    }
    
    window.location.assign(logoutUri);
  }

  webfinger(opts) {
    var url = '/.well-known/webfinger' + toQueryParams(opts);
    var options = {
      headers: {
        'Accept': 'application/jrd+json'
      }
    };
    return http.get(this, url, options);
  }
  
}

// Hoist feature detection functions to static type
OktaAuthBrowser.features = OktaAuthBrowser.prototype.features = features;

export default OktaAuthBrowser;


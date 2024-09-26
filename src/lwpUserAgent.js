"use strict";

import * as JsSIP from "jssip";
import { jwtDecode } from "jwt-decode";
import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";
import lwpCall from "./lwpCall";

export default class lwpUserAgent extends lwpRenderer {
  #config = {};
  #userAgent = null;
  #sockets = [];
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    // this._libwebphone = "kakac";
    // this._emit = this._libwebphone._userAgentEvent;
    this.#initProperties(config);
    this._initInternationalization(config.i18n || {});
    this.#initSockets();
    this.#initEventBindings();
    this.#initRenderTargets();
    this._emit("created", this);
    // this.initAgent = this._initAgent.bind(this);
    //return this;
  }
  start(username = null, password = null, realm = null) {
    if (this.isStarted()) {
      return;
    }

    if (username) {
      this.#config.authentication.username = username;
    }

    if (password) {
      this.#config.authentication.password = password;
    }

    if (realm) {
      this.#config.authentication.realm = realm;
    }

    try {
      const config = {
        sockets: this.#sockets,
        uri: "webphone@nodomain.invalid",
        connection_recovery_max_interval: this.#config.transport
          .recovery_max_interval,
        connection_recovery_min_interval: this.#config.transport
          .recovery_min_interval,
        contact_uri: this.#config.user_agent.contact_uri,
        display_name: this.#config.user_agent.display_name,
        instance_id: this.#config.user_agent.instance_id,
        no_answer_timeout: this.#config.user_agent.no_answer_timeout,
        realm: this.#config.authentication.realm,
        register: this.#config.user_agent.register,
        register_expires: this.#config.user_agent.register_expires,
        user_agent: this.#config.user_agent.user_agent,
        session_timers: false,
      };

      if (this.#config.authentication.jwt) {
        config.authorization_jwt = this.#config.authentication.jwt;
        const decoded = jwtDecode(config.authorization_jwt);
        if (decoded["SIP-Info"] && decoded["SIP-Info"]["User-Agent"]) {
          const jwt_user_agent = decoded["SIP-Info"]["User-Agent"];
          if (jwt_user_agent.Username) {
            config.authorization_user = jwt_user_agent.Username;
          }
          if (jwt_user_agent.Realm) {
            config.realm = jwt_user_agent.Realm;
          }
        }
      } else if (this.#config.authentication.password) {
        config.password = this.#config.authentication.password;
      }

      if (this.#config.authentication.username) {
        config.authorization_user = this.#config.authentication.username;
      }

      if (this.#config.authentication.realm) {
        config.realm = this.#config.authentication.realm;
      }

      if (config.authorization_user) {
        config.uri = config.authorization_user + "@" + config.uri.split("@")[1];
      }

      if (config.realm) {
        config.uri = config.uri.split("@")[0] + "@" + config.realm;
      }

      this.#initAgent(config);

      this.#userAgent.start();

      this.#userAgent.on("connected", (...event) => {
        this.updateRenders();
        this._emit("connected", this, ...event);
      });
      this.#userAgent.on("disconnected", (...event) => {
        this.updateRenders();
        this._emit("disconnected", this, ...event);
      });
      this.#userAgent.on("registered", (...event) => {
        this.#userAgent._contact.pub_gruu = null;
        this.#userAgent._contact.temp_gruu = null;
        this.updateRenders();
        this._emit("registration.registered", this, ...event);
      });
      this.#userAgent.on("unregistered", (...event) => {
        this.updateRenders();
        this._emit("registration.unregistered", this, ...event);
      });
      this.#userAgent.on("registrationFailed", (...event) => {
        this.updateRenders();
        this._emit("registration.failed", this, ...event);
      });
      this.#userAgent.on("registrationExpiring", (...event) => {
        this._emit("registration.expiring", this, ...event);
        this.#userAgent.register();
      });
      this.#userAgent.on("newRTCSession", (...event) => {
        const session = event[0].session;
        new lwpCall(this._libwebphone, session);
      });
      this.#userAgent.on("newMessage", (...event) => {
        this._emit("received.message", this, ...event);
      });
      this.#userAgent.on("sipEvent", (...event) => {
        this._emit("received.notify", this, ...event);
      });

      this._emit("started", this);
      return this.#userAgent;
    } catch (error) {
      this._emit("configuration.error", this, error);
    }
  }

  stop() {
    if (this.isStarted()) {
      this.hangupAll();
      this.unregister();
      this.#userAgent.stop();
      this.#userAgent = null;
      this._emit("stopped", this);
    }
  }

  isStarted() {
    return this.#userAgent != null;
  }

  isConnected() {
    if (this.isStarted()) {
      return this.#userAgent.isConnected();
    }

    return false;
  }

  startDebug() {
    this._debug = true;

    JsSIP.debug.enable("JsSIP:*");

    this._emit("debug.start", this);
  }

  stopDebug() {
    this._debug = false;

    JsSIP.debug.enable("");

    this._emit("debug.stop", this);
  }

  toggleDebug() {
    if (this.isDebugging()) {
      return this.stopDebug();
    } else {
      return this.startDebug();
    }
  }

  isDebugging() {
    return this._debug;
  }

  register() {
    if (this.isStarted()) {
      this.#userAgent.register();
    }
  }

  unregister() {
    if (this.isStarted()) {
      this.#userAgent.unregister({
        all: true,
      });
    }
  }

  toggleRegistration() {
    if (this.isRegistered()) {
      this.unregister();
    } else {
      this.register();
    }
  }

  isRegistered() {
    if (this.isStarted()) {
      return this.#userAgent.isRegistered();
    }

    return false;
  }

  redial() {
    const redialTarget = this.getRedial();

    this._emit("redial.started", this, redialTarget);

    return this.call(redialTarget);
  }

  getRedial() {
    return this._redialTarget;
  }

  setRedial(target) {
    if (this._redialTarget == target) {
      return;
    }

    this._redialTarget = target;

    this._emit("redial.update", this, this._redialTarget);
  }

  call(target = null, custom_headers = [], options = false, userData = {}) {
    let defaultOptions = {
      data: lwpUtils.merge(userData,{ lwpStreamId: lwpUtils.uuid() }),
      extraHeaders: [...custom_headers, ...this.#config.custom_headers.establish_call],
    };
    if (typeof options === 'boolean') {
      defaultOptions.anonymous = options;
    }
    if (typeof options === 'object') {
      defaultOptions.rtcOfferConstraints = {
        offerToReceiveVideo: options.receive_video || false
      };
      defaultOptions.anonymous = options.anonymous || false
    }
    const mediaDevices = this._libwebphone.getMediaDevices();
    const callList = this._libwebphone.getCallList();

    if (!target) {
      target = this.getRedial();
    } else {
      this.setRedial(target);
    }

    if (!callList) {
      this.hangupAll();
    }

    if (mediaDevices) {
      mediaDevices
        .startStreams(defaultOptions.data.lwpStreamId)
        .then((streams) => {
          options = lwpUtils.merge(defaultOptions, {
            mediaStream: streams,
          });
          this._call(target, defaultOptions);
        })
        .catch((error) => {
          this._emit("call.failed", this, error);
        });
    } else {
      this._call(target, defaultOptions);
    }
  }

  hangupAll() {
    if (this.isStarted()) {
      this.#userAgent.terminateSessions();
    }
  }

  isReady() {
    return this.isStarted() && this.isConnected() && this.isRegistered();
  }

  updateRenders() {
    this.render((render) => {
      render.data = this._renderData(render.data);
      return render;
    });
  }

  /** Init functions */

  _initInternationalization(config) {
    const defaults = {
      en: {
        agentstart: "Start",
        agentstop: "Stop",
        debug: "Debug",
        debugstart: "Start",
        debugstop: "Stop",
        username: "Username",
        password: "Password",
        realm: "Realm",
        registrar: "Registrar",
        register: "Register",
        unregister: "Unregister",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("userAgent", resourceBundles);
  }

  #initProperties(config) {
    const defaults = {
      transport: {
        sockets: [],
        recovery_max_interval: 30,
        recovery_min_interval: 2,
      },
      authentication: {
        username: "",
        password: "",
        realm: "",
      },
      user_agent: {
        //contact_uri: "",
        //display_name: "",
        //instance_id: "8f1fa16a-1165-4a96-8341-785b1ef24f12",
        no_answer_timeout: 60,
        register: true,
        register_expires: 300,
        user_agent: "2600Hz libwebphone 2.x",
        redial: "*97"
      },
      custom_headers: {
        establish_call: []
      },
      custom_parameters: {
        contact_uri: {}
      },
      debug: false,
    };

    this.#config = lwpUtils.merge(defaults, config);

    this.setRedial(this.#config.user_agent.redial);

    if (this.#config.debug) {
      this.startDebug();
    } else {
      this.stopDebug();
    }
  }

  #initSockets() {
    this.#config.transport.sockets.forEach((socket) => {
      // TODO: handle when socket is an object with weights...
      this.#sockets.push(new JsSIP.WebSocketInterface(socket));
    });
  }

  #initAgent(config) {
    this.#userAgent = new JsSIP.UA(config);
    this.#userAgent.receiveRequest = (request) => {
      /** TODO: nasty hack because Kazoo appears to be lower-casing the request user... */
      const config_user = this.#userAgent._configuration.uri.user;
      const ruri_user = request.ruri.user;
      if (config_user.toLowerCase() == ruri_user.toLowerCase()) {
        request.ruri.user = config_user;
      }
      return this.#userAgent.__proto__.receiveRequest.call(
        this.#userAgent,
        request
      );
    };

    if (this.#config.custom_parameters.contact_uri) {
      this.#userAgent.registrator().setExtraContactParams(this.#config.custom_parameters.contact_uri);
    }

    if (this.#config.custom_headers.register) {
      this.#userAgent.registrator().setExtraHeaders(this.#config.custom_headers.register);
      console.log(this.#userAgent);
    }
  }

  #initEventBindings() {
    this._libwebphone.on("userAgent.debug.start", () => {
      this.updateRenders();
    });
    this._libwebphone.on("userAgent.debug.stop", () => {
      this.updateRenders();
    });
    this._libwebphone.on("userAgent.call.failed", () => {
      this.updateRenders();
    });
    this._libwebphone.onAny((event, ...data) => {
      if (this.isDebugging()) {
        console.log(event, data);
      }
    });
  }

  #initRenderTargets() {
    this.#config.renderTargets.map((renderTarget) => {
      return this.renderAddTarget(renderTarget);
    });
  }

  /** Render Helpers */

  _renderDefaultConfig() {
    return {
      template: this._renderDefaultTemplate(),
      i18n: {
        agentstart: "libwebphone:userAgent.agentstart",
        agentstop: "libwebphone:userAgent.agentstop",
        debug: "libwebphone:userAgent.debug",
        debugstart: "libwebphone:userAgent.debugstart",
        debugstop: "libwebphone:userAgent.debugstop",
        registrar: "libwebphone:userAgent.registrar",
        register: "libwebphone:userAgent.register",
        unregister: "libwebphone:userAgent.unregister",
        username: "libwebphone:userAgent.username",
        password: "libwebphone:userAgent.password",
        realm: "libwebphone:userAgent.realm",
      },
      data: lwpUtils.merge({}, this.#config, this._renderData()),
      by_id: {
        debug: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.toggleDebug();
            },
          },
        },
        registrar: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.toggleRegistration();
            },
          },
        },
        username: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.#config.authentication.username = element.value;
            },
          },
        },
        password: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.#config.authentication.password = element.value;
            },
          },
        },
        realm: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.#config.authentication.realm = element.value;
            },
          },
        },
        agentstart: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.start();
            },
          },
        },
        agentstop: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.stop();
            },
          },
        },
      },
    };
  }

  _renderDefaultTemplate() {
    return `
    <div>
      <div>
        <label for="{{by_id.debug.elementId}}">
          {{i18n.debug}}
        </label>
        <button id="{{by_id.debug.elementId}}">
          {{^data.isDebugging}}
            {{i18n.debugstart}}
          {{/data.isDebugging}}

          {{#data.isDebugging}}
            {{i18n.debugstop}}
          {{/data.isDebugging}}
        </button>
      </div>

      {{^data.isStarted}}
        <div>
          <label for="{{by_id.username.elementId}}">
            {{i18n.username}}
          </label>
          <input type="text" id="{{by_id.username.elementId}}" value="{{data.authentication.username}}" />
        </div>

        <div>
          <label for="{{by_id.password.elementId}}">
            {{i18n.password}}
          </label>
          <input type="text" id="{{by_id.password.elementId}}" value="{{data.authentication.password}}" />
        </div>
        
        <div>
          <label for="{{by_id.realm.elementId}}">
            {{i18n.realm}}
          </label>
          <input type="text" id="{{by_id.realm.elementId}}" value="{{data.authentication.realm}}" />
        </div>

        <div>
          <label for="{{by_id.agentstart.elementId}}">
            {{i18n.agent}}
          </label>
          <button id="{{by_id.agentstart.elementId}}">{{i18n.agentstart}}</button>
        </div>
      {{/data.isStarted}}

      {{#data.isStarted}}
        <div>
          <label for="{{by_id.registrar.elementId}}">
            {{i18n.registrar}}
          </label>
          <button id="{{by_id.registrar.elementId}}">
            {{^data.isRegistered}}
              {{i18n.register}}
            {{/data.isRegistered}}

            {{#data.isRegistered}}
              {{i18n.unregister}}
            {{/data.isRegistered}}
          </button>
        </div>

        <label for="{{by_id.agentstop.elementId}}">
          {{i18n.agent}}
        </label>
        <button id="{{by_id.agentstop.elementId}}">{{i18n.agentstop}}</button>
      {{/data.isStarted}}
    </div>
      `;
  }

  _renderData(data = {}) {
    data.isStarted = this.isStarted();
    data.isConnected = this.isConnected();
    data.isRegistered = this.isRegistered();
    data.isReady = this.isReady();
    data.isDebugging = this.isDebugging();

    return data;
  }

  /** Helper functions */

  _call(target, options) {
    try {
      if (!this.isReady()) {
        throw new Error("Webphone client not ready yet!");
      }

      this.#userAgent.call(target, options);

      this._emit("call.started", this, target);
    } catch (error) {
      this._emit("call.failed", this, error);
    }
  }
}

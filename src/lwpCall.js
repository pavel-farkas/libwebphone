"use strict";

import lwpUtils from "./lwpUtils";
import prettyMilliseconds from "pretty-ms";

export default class lwpCall {
  #libwebphone;
  #id;
  #session;
  #primary = false;
  #inTransfer = false;
  // #muteHint = false;
  #config = {};
  #streams = {};
  #answerTime = null;

  constructor(libwebphone, session = null) {
    this.#libwebphone = libwebphone;
    this.#id = session
      ? session.data.lwpStreamId || lwpUtils.uuid()
      : lwpUtils.uuid();
    this.#session = session;
    this.#initProperties();
    this.#initEventBindings();

    const callList = this.#libwebphone.getCallList();
    if (!callList) {
      this.setPrimary();
    }

    this.#emit("created");

    if (session) {
      this.#timeUpdate();
    }
  }

  getId() {
    return this.#id;
  }

  hasSession() {
    return this.#session != null;
  }

  getSessionUserData() {
    if (this.hasSession()) {
      return this.#session.data;
    }
  }
  addSessionUserData(userData) {
    if (this.hasSession()) {
      this.#session.data = lwpUtils.merge(
        this.#session.data,
        userData
      );
    }
  }

  hasPeerConnection() {
    return this.#session && this.#session.connection;
  }

  getPeerConnection() {
    if (this.hasPeerConnection()) {
      return this.#session.connection;
    }
  }

  isPrimary() {
    return this.#primary;
  }

  getRemoteAudio() {
    return this.#streams.remote.elements.audio;
  }

  getRemoteVideo() {
    return this.#streams.remote.elements.video;
  }

  getLocalAudio() {
    return this.#streams.local.elements.audio;
  }

  getLocalVideo() {
    return this.#streams.local.elements.video;
  }

  isInProgress() {
    if (this.hasSession()) {
      return this.#session.isInProgress();
    }

    return false;
  }

  isEstablished() {
    if (this.hasSession()) {
      return this.#session.isEstablished();
    }

    return false;
  }

  isEnded() {
    if (this.hasSession()) {
      return this.#session.isEnded();
    }

    return false;
  }

  isRinging() {
    return this.getDirection() == "terminating" && !this.isEstablished();
  }

  isInTransfer() {
    return this.#inTransfer;
  }

  getDirection() {
    if (this.hasSession()) {
      if (this.#session.direction == "incoming") {
        return "terminating";
      } else {
        return "originating";
      }
    }

    return "originating";
  }

  localIdentity(details = false) {
    const session = this.#session;
    if (session) {
      if (details) {
        return session.local_identity;
      }
      const display_name = session.local_identity.display_name;
      const uri_user = session.local_identity.uri.user;

      if (display_name && display_name != uri_user) {
        return display_name + " (" + uri_user + ")";
      } else {
        return uri_user;
      }
    }
  }

  remoteIdentity(details = false) {
    const session = this.#session;
    if (session) {
      if (details) {
        return session.remote_identity;
      }
      const display_name = session.remote_identity.display_name;
      const uri_user = session.remote_identity.uri.user;

      if (display_name && display_name != uri_user) {
        return display_name + " (" + uri_user + ")";
      } else {
        return uri_user;
      }
    }
  }

  remoteURIUser() { 
    const session = this.#session;
    if (session) {
      return session._dialog._remote_uri.user;
    }
  }

  terminate() {
    if (this.hasSession()) {
      if (this.isEstablished()) {
        this.hangup();
      } else {
        this.cancel();
      }
    }
  }

  cancel() {
    if (this.hasSession()) {
      this.#session.terminate();
    }
  }

  hangup() {
    if (this.hasSession()) {
      this.#session.terminate();
    }
  }

  hold() {
    if (this.hasSession()) {
      this.#session.hold();
    }
  }

  isOnHold(details = false) {
    let status = { local: false, remote: false };

    if (this.hasSession()) {
      status = this.#session.isOnHold();
    }

    if (details) {
      return status;
    } else {
      return status.local || status.remote;
    }
  }

  unhold() {
    if (this.hasSession()) {
      this.#session.unhold();
      this.#updateStreams();
    }
  }

  /**
   * @param {{audio: boolean, video: boolean}} options - The channels you want to mute
   */
  mute(options = { audio: true, video: true }) {
    if (this.hasSession()) {
      this.#session.mute(options);
    }
  }

  /**
   * @param {{audio: boolean, video: boolean}} options - The channels you want to unmute
   */
  unmute(options = { audio: true, video: true }) {
    if (this.hasSession()) {
      this.#session.unmute(options);
    }
  }

  isMuted(details = false) {
    let status = { audio: false, video: false };

    if (this.hasSession()) {
      status = this.#session.isMuted();
    }

    if (details) {
      return status;
    } else {
      return status.audio || status.video;
    }
  }

  transfer(target = null, autoHold = true) {
    if (this.hasSession()) {
      if (this.isInTransfer() || target) {
        const dialpad = this.#libwebphone.getDialpad();

        this.#inTransfer = false;

        if (!target && dialpad) {
          target = dialpad.getTarget(true);
        }

        if (target && target instanceof lwpCall) {
          const aor = target.getSession().remote_identity.uri.toAor();
          this.#session.refer(aor, {'replaces': target.getSession()});
           this.#emit("transfer.complete", target);
        } else if (target) {
          this.#session.refer(target);
          this.#emit("transfer.started", target);
        } else {
          if (autoHold) {
            this.unhold();
          }
          this.#emit("transfer.failed", target);
        }

        this.#emit("transfer.complete", target);
      } else {
        this.#inTransfer = true;

        if (autoHold) {
          this.hold();
        }

        this.#emit("transfer.collecting");
      }
    }
  }

  answer() {
    if (this.hasSession()) {
      const mediaDevices = this.#libwebphone.getMediaDevices();

      if (mediaDevices) {
        mediaDevices.startStreams(this.getId()).then((streams) => {
          const options = {
            mediaStream: streams,
            extraHeaders: [
              "Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, MESSAGE, INFO, UPDATE, REFER, NOTIFY"
            ]
          };

          if (this.#libwebphone._config.userAgent && this.#libwebphone._config.userAgent.user_agent && this.#libwebphone._config.userAgent.user_agent.user_agent) {
            options.extraHeaders.push("User-Agent: " + this.#libwebphone._config.userAgent.user_agent.user_agent);
          }

          this.#session.answer(options);
          this.#emit("answered");
        });
      } else {
        this.#session.answer({});
        this.#emit("answered");
      }
    }
  }

  reject() {
    if (this.hasSession()) {
      this.#session.terminate();
      this.#emit("rejected");
    }
  }

  renegotiate() {
    if (this.hasSession() && !this.isOnHold()) {
      this.#session.renegotiate();
      this.#updateStreams();
      this.#emit("renegotiated");
    }
  }

  sendDTMF(signal, options) {
    if (this.hasSession()) {
      this.#session.sendDTMF(signal, options);
      this.#emit("send.dtmf", signal, options);
    }
  }

  changeVolume(volume = null, kind = null) {
    if (volume === null && this.#libwebphone.getAudioContext()) {
      volume = this.#libwebphone
        .getAudioContext()
        .getVolume("remote", { scale: false, relativeToMaster: true });
    }

    if (!volume && volume !== 0) {
      return;
    }

    if (volume < 0) {
      volume = 0;
    }

    if (volume > 1) {
      volume = 1;
    }

    if (kind) {
      const element = this.#streams.remote.elements[kind];
      if (element) {
        element.volume = volume;
      }
    } else {
      Object.keys(this.#streams.remote.elements).forEach((kind) => {
        const element = this.#streams.remote.elements[kind];
        if (element) {
          element.volume = volume;
        }
      });
    }
  }

  replaceSenderTrack(newTrack) {
    const peerConnection = this.getPeerConnection();
    if (!peerConnection) {
      return;
    }

    if (
      peerConnection.signalingState == "closed" ||
      peerConnection.connectionState == "closed"
    ) {
      return;
    }

    const senders = peerConnection.getSenders();
    const sender = senders.find((sender) => {
      const track = sender.track;
      if (track) {
        return track.kind == newTrack.kind;
      }
    });

    if (sender) {
      sender.replaceTrack(newTrack).then(() => {
        this.renegotiate();
      });
    } else {
      peerConnection.addTrack(newTrack);
      this.renegotiate();
    }
  }

  removeSenderTrack(kind) {
    const peerConnection = this.getPeerConnection();
    if (!peerConnection) {
      return;
    }

    if (
      peerConnection.signalingState == "closed" ||
      peerConnection.connectionState == "closed"
    ) {
      return;
    }

    const senders = peerConnection.getSenders();
    const sender = senders.find((sender) => {
      const track = sender.track;
      if (track) {
        return track.kind == kind;
      }
    });

    if (sender) {
      peerConnection.removeTrack(sender);
      this.renegotiate();
    }
  }

  summary() {
    const direction = this.getDirection();
    const { audio: isAudioMuted, video: isVideoMuted } = this.isMuted(true);

    return {
      callId: this.getId(),
      hasSession: this.hasSession(),
      progress: this.isInProgress(),
      established: this.isEstablished(),
      ended: this.isEnded(),
      held: this.isOnHold(),
      isAudioMuted,
      isVideoMuted,
      primary: this.isPrimary(),
      inTransfer: this.isInTransfer(),
      direction: direction,
      terminating: direction == "terminating",
      originating: direction == "originating",
      localIdentity: this.localIdentity(),
      remoteIdentity: this.remoteIdentity(),
    };
  }

  /** Init functions */

  #initMediaElement(elementKind, deviceKind) {
    const element = document.createElement(elementKind);

    if (elementKind === "video") {
      try {
        element.setAttribute('webkit-playsinline', 'webkit-playsinline');
        element.setAttribute('playsinline', 'playsinline');
      } catch (error) {
        this.#emit("error", error);
      }
    }

    if (this.hasSession() && element.setSinkId !== undefined) {
      const preferedDevice = this.#libwebphone
        .getMediaDevices()
        .getPreferedDevice(deviceKind);

      if (preferedDevice) {
        try {
          element.setSinkId(preferedDevice.id);
        } catch (error) {
         this.#emit("error", error);
        }
      }
    }

    return element;
  }

  #initProperties() {

    this.#config = this.#libwebphone._config.call;

    this.#streams = {
      remote: {
        mediaStream: new MediaStream(),
        kinds: {
          audio: false,
          video: false,
        },
        elements: {
          audio: this.#initMediaElement("audio", "audiooutput"),
          video: this.#initMediaElement("video", "videoinput"),
        },
      },
      local: {
        mediaStream: new MediaStream(),
        kinds: {
          audio: false,
          video: false,
        },
        elements: {
          audio: this.#initMediaElement("audio", "audiooutput"),
          video: this.#initMediaElement("video", "videoinput"),
        },
      },
    };

    Object.keys(this.#streams).forEach((type) => {
      Object.keys(this.#streams[type].elements).forEach((kind) => {
        const element = this.#streams[type].elements[kind];

        lwpUtils.mediaElementEvents().forEach((eventName) => {
          element.addEventListener(eventName, (event) => {
            this.#emit(
              type + "." + kind + "." + eventName,
              element,
              event
            );
          });
        });

        if (this.#config.useAudioContext) {
          element.muted = true;
        } else {
          // NOTE: don't mute the remote audio by default
          element.muted = !(type == "remote" && kind == "audio");
        }
        element.preload = "none";

        this.#emit(type + "." + kind + ".element", element);
      });
    });

    if (this.isRinging()) {
      this.#emit("ringing.started");
    }
  }

  #initEventBindings() {
    this.#libwebphone.on(
      "mediaDevices.audio.input.changed",
      (lwp, mediaDevices, newTrack) => {
        if (this.hasSession()) {
          if (newTrack) {
            this.replaceSenderTrack(newTrack.track);
          } else {
            this.removeSenderTrack("audio");
          }
        }
      }
    );
    this.#libwebphone.on(
      "mediaDevices.video.input.changed",
      (lwp, mediaDevices, newTrack) => {
        if (this.hasSession() && newTrack) {
          this.replaceSenderTrack(newTrack.track);
        }
      }
    );
    this.#libwebphone.on(
      "mediaDevices.audio.output.changed",
      (lwp, mediaDevices, preferedDevice) => {
        Object.keys(this.#streams.remote.elements).forEach((kind) => {
          const element = this.#streams.remote.elements[kind];
          if (element && element.setSinkId !== undefined) {
            try {
              element.setSinkId(preferedDevice.id);
            } catch (error) {
              this.#emit("error", error);
            }
          }
        });
      }
    );

    this.#libwebphone.on("audioContext.channel.master.volume", () => {
      this.changeVolume();
    });
    this.#libwebphone.on("audioContext.channel.remote.volume", () => {
      this.changeVolume();
    });

    if (this.hasPeerConnection()) {
      const peerConnection = this.getPeerConnection();
      this.#emit("peerconnection", peerConnection);
      peerConnection.addEventListener("track", (...event) => {
        this.#emit("peerconnection.add.track", ...event);
        this.#updateStreams();
      });
      peerConnection.addEventListener("removestream", (...event) => {
        this.#emit("peerconnection.remove.track", ...event);
        this.#updateStreams();
      });
    }
    if (this.hasSession()) {
      this.#session.on("progress", (...event) => {
        this.#emit("progress", ...event);
      });
      this.#session.on("connecting", () => {
        // Mute video and audio after the local media stream is added into RTCSession
        this.#session.mute({
          audio: this.#config.startWithAudioMuted,
          video: this.#config.startWithVideoMuted,
        });
      });
      this.#session.on("confirmed", (...event) => {
        this.#answerTime = new Date();
        this.#emit("ringing.stopped");
        this.#emit("established", ...event);
      });
      this.#session.on("newDTMF", (...event) => {
        this.#emit("receive.dtmf", ...event);
      });
      this.#session.on("newInfo", (...event) => {
        this.#emit("receive.info", ...event);
      });
      this.#session.on("hold", (...event) => {
        this.#emit("hold", ...event);
      });
      this.#session.on("unhold", (...event) => {
        this.#emit("unhold", ...event);
      });
      this.#session.on("muted", (...event) => {
        this.#emit("muted", ...event);
      });
      this.#session.on("unmuted", (...event) => {
        this.#emit("unmuted", ...event);
      });
      this.#session.on("update", (...event) => {
        const request = event[0].request || null;
        const session = this.#session;
        if (request && session && request.method === "UPDATE" && request.from) {
          session.remote_identity.display_name = request.from._display_name;
          session.remote_identity.uri.user = request.from._uri;
        }
        this.#emit("update", ...event);
      });
      this.#session.on("ended", (...event) => {
        this.#destroyCall();
        this.#emit("ended", ...event);
      });
      this.#session.on("failed", (...event) => {
        this.#destroyCall();
        this.#emit("failed", ...event);
      });
      this.#session.on("peerconnection", (...data) => {
        const peerConnection = data[0].peerconnection;
        this.#emit("peerconnection", peerConnection);
        peerConnection.addEventListener("track", (...event) => {
          this.#emit("peerconnection.add.track", ...event);
          this.#updateStreams();
        });
        peerConnection.addEventListener("remotestream", (...event) => {
          this.#emit("peerconnection.remove.track", ...event);
          this.#updateStreams();
        });
      });

      if (this.#config.globalKeyShortcuts) {
        document.addEventListener("keydown", (event) => {
          if (
            event.target != document.body ||
            event.repeat ||
            !this.isPrimary()
          ) {
            return;
          }

          switch (event.key) {
            case " ":
              if (this.#config.keys["spacebar"].enabled) {
                this.#config.keys["spacebar"].action(event, this);
              }
              break;
          }
        });
        document.addEventListener("keyup", (event) => {
          if (
            event.target != document.body ||
            event.repeat ||
            !this.isPrimary()
          ) {
            return;
          }

          switch (event.key) {
            case " ":
              if (this.#config.keys["spacebar"].enabled) {
                this.#config.keys["spacebar"].action(event, this);
              }
              break;
          }
        });
      }
    }
  }

  /** Helper functions */
  #timeUpdate() {
    if (this.#answerTime) {
      const duration = new Date() - this.#answerTime;
      const options = {
        secondsDecimalDigits: 0,
      };

      this.#emit(
        "timeupdate",
        this.#answerTime,
        duration,
        prettyMilliseconds(Math.ceil(duration / 1000) * 1000, options)
      );
    }

    if (this.hasSession()) {
      setTimeout(() => {
        this.#timeUpdate();
      }, 100);
    }
  }

  #destroyCall() {
    this.#emit("terminated");

    if (this.isPrimary()) {
      this.clearPrimary(false);
    }

    this.#destroyStreams();

    this.#session = null;
  }

  getSession() {
    return this.#session;
  }

  setPrimary(resume = true) {
    if (this.isPrimary()) {
      return;
    }

    if (resume && this.isEstablished() && this.isOnHold()) {
      this.unhold();
    }

    this.#emit("promoted");

    this.#primary = true;

    this.#connectStreams();
  }

  clearPrimary(pause = true) {
    if (!this.isPrimary()) {
      return;
    }

    if (this.isInTransfer()) {
      this.#inTransfer = false;

      this.#emit("transfer.failed");
    }

    this.#primary = false;

    if (pause && this.isEstablished() && !this.isOnHold()) {
      this.hold();
    }

    this.#disconnectStreams();

    this.#emit("demoted");
  }

  #updateStreams() {
    Object.keys(this.#streams).forEach((type) => {
      const peerConnection = this.getPeerConnection();
      const mediaStream = this.#streams[type].mediaStream;
      if (peerConnection) {
        const peerTracks = [];
        switch (type) {
          case "remote":
            peerConnection.getReceivers().forEach((peer) => {
              if (peer.track) {
                peerTracks.push(peer.track);
              }
            });
            break;
          case "local":
            peerConnection.getSenders().forEach((peer) => {
              const track = peer.track;
              if (track) {
                track.enabled = !this.isMuted(true)[track.kind];
                peerTracks.push(track);
              }
            });
            break;
        }
        this.#syncTracks(mediaStream, peerTracks, type);
      }

      Object.keys(this.#streams[type].elements).forEach((kind) => {
        const element = this.#streams[type].elements[kind];
        if (element) {
          const track = mediaStream.getTracks().find((track) => {
            return track.kind == kind;
          });

          if (track) {
            this.#streams[type].kinds[kind] = true;
            if (!element.srcObject || element.srcObject.id != mediaStream.id) {
              element.srcObject = mediaStream;
            }
          } else {
            this.#streams[type].kinds[kind] = false;
            element.srcObject = null;
          }
        }
      });
    });
  }

  #syncTracks(mediaStream, peerTracks, type) {
    const peerIds = peerTracks.map((track) => {
      return track.id;
    });
    const currentIds = mediaStream.getTracks().map((track) => {
      return track.id;
    });
    const addIds = peerIds.filter((peerId) => {
      return !currentIds.includes(peerId);
    });
    const removeIds = currentIds.filter((currentId) => {
      return !peerIds.includes(currentId);
    });
    mediaStream.getTracks().forEach((track) => {
      if (removeIds.includes(track.id)) {
        mediaStream.removeTrack(track);
        this.#emit(
          type + "." + track.kind + ".removed",
          lwpUtils.trackParameters(mediaStream, track)
        );
      }
    });
    peerTracks.forEach((track) => {
      if (addIds.includes(track.id)) {
        mediaStream.addTrack(track);
        this.#emit(
          type + "." + track.kind + ".added",
          lwpUtils.trackParameters(mediaStream, track)
        );
      }
    });
  }

  #connectStreams() {
    Object.keys(this.#streams).forEach((type) => {
      const mediaStream = this.#streams[type].mediaStream;
      this.#emit(type + ".mediaStream.connect", mediaStream);
    });

    if (!this.hasSession()) {
      return;
    }

    const peerConnection = this.getPeerConnection();
    if (peerConnection) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.enabled = true;
        }
      });
    }

    Object.keys(this.#streams).forEach((type) => {
      Object.keys(this.#streams[type].elements).forEach((kind) => {
        const element = this.#streams[type].elements[kind];
        if (element && element.paused) {
          element.play().catch(() => {
            /*
             * We are catching any play interuptions
             * because we get a "placeholder" remote video
             * track in the mediaStream for ALL calls but
             * it never gets data so the play never starts
             * and if we then pause there is a nasty looking
             * but ignorable error...
             *
             * https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
             *
             */
          });
        }
        this.#emit(type + "." + kind + ".connect", element);
      });
    });
  }

  #disconnectStreams() {
    Object.keys(this.#streams).forEach((type) => {
      const mediaStream = this.#streams[type].mediaStream;
      this.#emit(type + ".mediaStream.disconnect", mediaStream);
    });

    if (!this.hasSession()) {
      return;
    }

    const peerConnection = this.getPeerConnection();
    if (peerConnection) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.enabled = false;
        }
      });
    }

    Object.keys(this.#streams).forEach((type) => {
      Object.keys(this.#streams[type].elements).forEach((kind) => {
        const element = this.#streams[type].elements[kind];
        if (element && !element.paused) {
          element.pause();
        }
        this.#emit(type + "." + kind + ".disconnect", element);
      });
    });
  }

  #destroyStreams() {
    this.#emit("ringing.stopped");

    const peerConnection = this.getPeerConnection();
    if (peerConnection) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.stop();
        }
      });
    }
  }

  #emit(type, ...data) {
    data.unshift(this);
    data.unshift(this.#libwebphone);
    data.unshift("call." + type);

    this.#libwebphone._emit.apply(this.#libwebphone, data);

    if (this.isPrimary()) {
      data.shift();
      data.unshift("call.primary." + type);
      this.#libwebphone._emit.apply(this.#libwebphone, data);

      data.shift();
      data.unshift("call.primary.update");
      data.push(type);
      this.#libwebphone._emit.apply(this.#libwebphone, data);
    }
  }
}

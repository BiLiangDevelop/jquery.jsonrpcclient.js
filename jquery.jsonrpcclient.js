/**
 * This plugin requires jquery.json.js to be available, or at least the methods $.toJSON and
 * $.parseJSON.
 *
 * The plan is to make use of websockets if they are available, but work just as well with only
 * http if not.
 *
 * Usage example:
 *
 *   var foo = new $.JsonRpcClient({ ajaxUrl: '/backend/jsonrpc' });
 *   foo.call(
 *     'bar', [ 'A parameter', 'B parameter' ],
 *     function(result) { alert('Foo bar answered: ' + result.my_answer); },
 *     function(error)  { console.log('There was an error', error); }
 *   );
 *
 * More examples are available in README.md
 */
(function($) {
  /**
   * @fn new
   * @memberof $.JsonRpcClient
   *
   * @param options An object stating the backends:
   *                ajaxUrl    A url (relative or absolute) to a http(s) backend.
   *                socketUrl  A url (relative of absolute) to a ws(s) backend.
   *                onmessage  A socket message handler for other messages (non-responses).
   *                getSocket  A function returning a WebSocket or null.
   *                           It must take an onmessage_cb and bind it to the onmessage event
   *                           (or chain it before/after some other onmessage handler).
   *                           Or, it could return null if no socket is available.
   *                           The returned instance must have readyState <= 1, and if less than 1,
   *                           react to onopen binding.
   */
  $.JsonRpcClient = function(options) {
    var self = this;
    this.options = $.extend({
      ajaxUrl     : null,
      socketUrl   : null, ///< The ws-url for default getSocket.
      onmessage   : null, ///< Other onmessage-handler.
      getSocket   : function(onmessage_cb) { return self._getSocket(onmessage_cb); }
    }, options);

    // Declare an instance version of the onmessage callback to wrap 'this'.
    this.wsOnMessage = function(event) { self._wsOnMessage(event); };
  };

  /// Holding the WebSocket on default getsocket.
  $.JsonRpcClient.prototype._ws_socket = null;

  /// Object <id>: { success_cb: cb, error_cb: cb }
  $.JsonRpcClient.prototype._ws_callbacks = {};

  /// The next JSON-RPC request id.
  $.JsonRpcClient.prototype._current_id = 1;

  /// When storing batch calls, this is non-null.
  $.JsonRpcClient.prototype._batch = null;

  /**
   * @fn call
   * @memberof $.JsonRpcClient
   *
   * @param method     The method to run on JSON-RPC server.
   * @param params     The params; an array or object.
   * @param success_cb A callback for successful request.
   * @param error_cb   A callback for error.
   */
  $.JsonRpcClient.prototype.call = function(method, params, success_cb, error_cb) {
    // Construct the JSON-RPC 2.0 request.
    var request = {
      jsonrpc : '2.0',
      method  : method,
      params  : params,
      id      : this._current_id++  // Increase the id counter to match request/response
    };

    // Try making a WebSocket call. (Batching is irrelevant in WebSocket.)
    var socket = this.options.getSocket(this.wsOnMessage);
    if (socket !== null) {
      this._wsCall(socket, request, success_cb, error_cb);
      return;
    }

    if (this._batch !== null) {
      // We're in a batch, just enqueue the data.
      this._batch.push({
        request    : request,
        success_cb : success_cb,
        error_cb   : error_cb
      });
      return;
    }

    // No WebSocket, and no HTTP backend?  This won't work.
    if (this.options.ajaxUrl === null) {
      throw "$.JsonRpcClient.call used with no websocket and no http endpoint.";
    }

    $.ajax({
      type     : 'POST',
      url      : this.options.ajaxUrl,
      data     : $.toJSON(request),
      dataType : 'json',
      cache    : false,

      success  : function(data) {
        if ('error' in data) error_cb(data.error);
        success_cb(data.result);
      },

      // JSON-RPC Server could return non-200 on error
      error    : function(jqXHR, textStatus, errorThrown) {
        try {
          var response = $.parseJSON(jqXHR.responseText);
          if ('console' in window) console.log(response);
          error_cb(response.error);
        }
        catch (err) {
          // Perhaps the responseText wasn't really a jsonrpc-error.
          error_cb({ error: jqXHR.responseText });
        }
      }
    });
  };

  /**
   * Notify sends a command to the server that won't need a response.  In http, there is probably
   * an empty response - that will be dropped, but in ws there should be no response at all.
   *
   * This is very similar to call, but has no id and no handling of callbacks.
   *
   * @fn notify
   * @memberof $.JsonRpcClient
   *
   * @param method     The method to run on JSON-RPC server.
   * @param params     The params; an array or object.
   */
  $.JsonRpcClient.prototype.notify = function(method, params) {
    // Construct the JSON-RPC 2.0 request.
    var request = {
      jsonrpc: '2.0',
      method:  method,
      params:  params
    };

    // Try making a WebSocket call. (Batching is irrelevant in WebSocket.)
    var socket = this.options.getSocket(this.wsOnMessage);
    if (socket !== null) {
      this._wsCall(socket, request);
      return;
    }

    if (this._batch !== null) {
      // We're in a batch, just enqueue the data.
      this._batch.push({ request: request });
      return;
    }

    // No WebSocket, and no HTTP backend?  This won't work.
    if (this.options.ajaxUrl === null) {
      throw "$.JsonRpcClient.notify used with no websocket and no http endpoint.";
    }

    $.ajax({
      type     : 'POST',
      url      : this.options.ajaxUrl,
      data     : $.toJSON(request),
      dataType : 'json',
      cache    : false
    });
  };

  /**
   * Start collecting calls into a batch.  This is only useful for HTTP backend, if WebSocket
   * backend is available, the call is made directly.  The batch is dispatched when this.endBatch
   * is called.
   *
   * @fn startBatch
   * @memberof $.JsonRpcClient
   */
  $.JsonRpcClient.prototype.startBatch = function() {
    if (this._batch === null) {
      this._batch = [];
    }
  };

  /**
   * Call this to execute all stored batch calls and end the batching.  All separate calls have
   * their own callbacks executed.  Note that the results can be handled in another order than
   * they were put in.
   *
   * @fn endBatch
   * @memberof $.JsonRpcClient
   *
   * @param all_done_cb A callback function to call after all results have been handled.
   * @parma error_cb    A callback function to call if there is an error from the server.
   *                    Note, that batch calls should always get an overall success, and the
   *                    only error
   */
  $.JsonRpcClient.prototype.endBatch = function(all_done_cb, error_cb) {
    var self = this;

    // No batch?
    if (this._batch === null) return;

    // Copy the batch and reset it, to avoid race conditions.
    var batch = this._batch;
    this._batch = null;

    // Empty batch?
    if (batch.length === 0) return;

    // Collect all request data and sort handlers by request id.
    var batch_request = [];
    var handlers = {};

    for (var i in batch) {
      var call = batch[i];
      batch_request.push(call.request);

      // If the request has an id, it should handle returns
      if ('id' in call.request) {
        handlers[call.request.id] = {
          success_cb : call.success_cb,
          error_cb   : call.error_cb
        };
      }
    }

    // Send request
    $.ajax({
      url      : this.options.ajaxUrl,
      data     : $.toJSON(batch_request),
      dataType : 'json',
      cache    : false,
      type     : 'POST',

      // Batch-requests should always return 200
      error    : function(jqXHR, textStatus, errorThrown) {
        if (typeof error_cb === 'function') error_cb(jqXHR, textStatus, errorThrown);
      },
      success  : function(data) { self._batchCb(data, handlers, all_done_cb); }
    });
  };

  /**
   * Internal helper to match the result array from a batch call to their respective callbacks.
   *
   * @fn _batchCb
   * @memberof $.JsonRpcClient
   */
  $.JsonRpcClient.prototype._batchCb = function(result, handlers, all_done_cb) {
    for (var i in result) {
      var response = result[i];

      // Handle error
      if ('error' in response) {
        if (response.id === null || response.id in handlers) {
          // An error on a notify?  Just log it to the console.
          if ('console' in window) console.log(response);
        }
        else handlers[response.id].error_cb(response.error);
      }
      else {
        // Here we should always have a correct id and no error.
        if (response.id in handlers && 'console' in window) console.log(response);
        else handlers[response.id].success_cb(response.result);
      }
    }

    if (typeof all_done_cb === 'function') all_done_cb(result);
  };

  /**
   * The default getSocket handler.
   *
   * @param onmessage_cb The callback to be bound to onmessage events on the socket.
   *
   * @fn _getSocket
   * @memberof $.JsonRpcClient
   */
  $.JsonRpcClient.prototype._getSocket = function(onmessage_cb) {
    // If there is no ws url set, we don't have a socket.
    // Likewise, if there is no window.WebSocket.
    if (this.options.socketUrl === null || !("WebSocket" in window)) return null;

    if (this._ws_socket === null || this._ws_socket.readyState > 1) {
      // No socket, or dying socket, let's get a new one.
      this._ws_socket = new WebSocket(this.options.socketUrl);

      // Set up onmessage handler.
      this._ws_socket.onmessage = onmessage_cb;
    }

    return this._ws_socket;
  };

  /**
   * Internal handler to dispatch a JRON-RPC request through a websocket.
   *
   * @fn _wsCall
   * @memberof $.JsonRpcClient
   */
  $.JsonRpcClient.prototype._wsCall = function(socket, request, success_cb, error_cb) {
    var request_json = $.toJSON(request);

    if (socket.readyState < 1) {
      // The websocket is not open yet; we have to set sending of the message in onopen.
      self = this; // In closure below, this is set to the WebSocket.  Use self instead.

      // Set up sending of message for when the socket is open.
      socket.onopen = function() {
        // Send the request.
        socket.send(request_json);
      };
    }
    else {
      // We have a socket and it should be ready to send on.
      socket.send(request_json);
    }

    // Setup callbacks.  If there is an id, this is a call and not a notify.
    if ('id' in request && typeof success_cb !== 'undefined') {
      this._ws_callbacks[request.id] = { success_cb: success_cb, error_cb: error_cb };
    }
  };

  /**
   * Internal handler for the websocket messages.  It determines if the message is a JSON-RPC
   * response, and if so, tries to couple it with a given callback.  Otherwise, it falls back to
   * given external onmessage-handler, if any.
   *
   * @param event The websocket onmessage-event.
   */
  $.JsonRpcClient.prototype._wsOnMessage = function(event) {
    // Check if this could be a JSON RPC message.
    try {
      var response = $.parseJSON(event.data);

      /// @todo Make using the jsonrcp 2.0 check optional, to use this on JSON-RPC 1 backends.

      if (typeof response === 'object'
          && 'jsonrpc' in response
          && response.jsonrpc === '2.0') {

        /// @todo Handle bad response (without id).

        // If this is an object with result, it is a response.
        if ('result' in response && this._ws_callbacks[response.id]) {
          // Get the success callback.
          var success_cb = this._ws_callbacks[response.id].success_cb;

          // Delete the callback from the storage.
          delete this._ws_callbacks[response.id];

          // Run callback with result as parameter.
          success_cb(response.result);
          return;
        }

        // If this is an object with error, it is an error response.
        else if ('error' in response && this._ws_callbacks[response.id]) {
          // Get the error callback.
          var error_cb = this._ws_callbacks[response.id].error_cb;

          // Delete the callback from the storage.
          delete this._ws_callbacks[response.id];

          // Run callback with the error object as parameter.
          error_cb(response.error);
          return;
        }
      }
    }
    catch (err) {
      // Probably an error while parsing a non json-string as json.  All real JSON-RPC cases are
      // handled above, and the fallback method is called below.
    }

    // This is not a JSON-RPC response.  Call the fallback message handler, if given.
    if (typeof this.options.onmessage === 'function') {
      this.options.onmessage(event);
    }
  };
})(jQuery);

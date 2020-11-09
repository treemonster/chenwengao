/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function define(obj, key, value) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    return obj[key];
  }
  try {
    // IE 8 has a broken Object.defineProperty that only works on DOM objects.
    define({}, "");
  } catch (err) {
    define = function(obj, key, value) {
      return obj[key] = value;
    };
  }

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    generator._invoke = makeInvokeMethod(innerFn, self, context);

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  IteratorPrototype[iteratorSymbol] = function () {
    return this;
  };

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunction.displayName = define(
    GeneratorFunctionPrototype,
    toStringTagSymbol,
    "GeneratorFunction"
  );

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      define(prototype, method, function(arg) {
        return this._invoke(method, arg);
      });
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      define(genFun, toStringTagSymbol, "GeneratorFunction");
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator, PromiseImpl) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return PromiseImpl.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return PromiseImpl.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new PromiseImpl(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);
  AsyncIterator.prototype[asyncIteratorSymbol] = function () {
    return this;
  };
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList, PromiseImpl) {
    if (PromiseImpl === void 0) PromiseImpl = Promise;

    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList),
      PromiseImpl
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var method = delegate.iterator[context.method];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method always terminates the yield* loop.
      context.delegate = null;

      if (context.method === "throw") {
        // Note: ["return"] must be used for ES3 parsing compatibility.
        if (delegate.iterator["return"]) {
          // If the delegate iterator has a return method, give it a
          // chance to clean up.
          context.method = "return";
          context.arg = undefined;
          maybeInvokeDelegate(delegate, context);

          if (context.method === "throw") {
            // If maybeInvokeDelegate(context) changed context.method from
            // "return" to "throw", let that override the TypeError below.
            return ContinueSentinel;
          }
        }

        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a 'throw' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  define(Gp, toStringTagSymbol, "Generator");

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  Function("r", "regeneratorRuntime = r")(runtime);
}

curinp.onkeyup = function (e) {
  sav1.className = 'show';
  $('.dtitle-active').html(curinp.value);
  document.title = curinp.value;
  save();
};

tags1.onkeyup = function (e) {
  sav1.className = 'show';
  save();
};

var save = simpledebounce(function _callee() {
  return regeneratorRuntime.async(function _callee$(_context) {
    while (1) {
      switch (_context.prev = _context.next) {
        case 0:
          _context.next = 2;
          return regeneratorRuntime.awrap(xhr('?do=save&id=' + qid + '&title=' + encodeURIComponent(curinp.value) + '&tags=' + encodeURIComponent(tags1.value), 'POST', inp.value));

        case 2:
          sav1.className = '';

        case 3:
        case "end":
          return _context.stop();
      }
    }
  }, null, null, null, Promise);
}, 1e3);

function del([id, title]) {
  if (!confirm('确定删除 ' + title + '?')) return;
  xhr('?do=del&id=' + id).then(function (_) {
    return location.reload();
  });
}

contentDL.onclick = function _callee2(_) {
  var canvas, a;
  return regeneratorRuntime.async(function _callee2$(_context2) {
    while (1) {
      switch (_context2.prev = _context2.next) {
        case 0:
          document.body.className = 'content-dl';
          canvas = null;
          _context2.prev = 2;
          _context2.next = 5;
          return regeneratorRuntime.awrap(new html2canvas(content, {
            width: content.offsetWidth,
            height: content.offsetHeight,
            allowTaint: true,
            useCORS: true
          }));

        case 5:
          canvas = _context2.sent;
          _context2.next = 13;
          break;

        case 8:
          _context2.prev = 8;
          _context2.t0 = _context2["catch"](2);
          _context2.next = 12;
          return regeneratorRuntime.awrap(new html2canvas(content, {
            width: content.offsetWidth,
            height: content.offsetHeight
          }));

        case 12:
          canvas = _context2.sent;

        case 13:
          a = document.createElement('a');
          a.href = canvas.toDataURL();
          document.body.appendChild(a);
          a.download = curinp.value + '.png';
          a.click();
          document.body.removeChild(a);
          document.body.className = '';

        case 20:
        case "end":
          return _context2.stop();
      }
    }
  }, null, null, [[2, 8]], Promise);
};

marked.setOptions({
  sanitize: true,
  highlight: function (code, lang) {
    try {
      return hljs.highlight(lang || 'sh', code).value;
    } catch (e) {
      return code;
    }
  }
});
var pos = {};

function calc_where(key, str) {
  var old = pos[key] || '';
  pos[key] = str;
  if (str === old) return;
  var len = Math.min(old.length, str.length);
  var cur = 0;

  for (; cur < len && old.charAt(cur) === str.charAt(cur); cur++) {
    ;
  }

  var lstr = str.substr(Math.max(cur - 20, 0), cur);
  cur -= lstr.match(/<[a-z\d]+$|$/i)[0].length;
  var rstr = str.substr(cur - 1, Math.min(str.length - cur, 20));
  cur += rstr.match(/^<\/[a-z\d]+>|$/i)[0].length;
  var ss = str.substr(0, cur);

  if (ss.match(/([a-z\d]+="[^>]*|<[a-z\d]*)$/i)) {
    for (; cur < str.length;) {
      if (str.charAt(cur - 1) === '>') break;
      cur++;
    }
  }

  return str.substr(0, cur) + '<i data-cur></i>' + str.substr(cur, str.length);
}

function uploadbackup() {
  var fs, b;
  return regeneratorRuntime.async(function uploadbackup$(_context4) {
    while (1) {
      switch (_context4.prev = _context4.next) {
        case 0:
          $('.btn-inp').html('正在导入..');
          fs = backupd.files;
          b = new FileReader();
          b.readAsArrayBuffer(fs[0]);

          b.onload = function _callee3(e) {
            var msg;
            return regeneratorRuntime.async(function _callee3$(_context3) {
              while (1) {
                switch (_context3.prev = _context3.next) {
                  case 0:
                    _context3.next = 2;
                    return regeneratorRuntime.awrap(xhr('?id=' + qid + '&do=importdata', 'POST', e.target.result));

                  case 2:
                    msg = _context3.sent;
                    alert(msg);
                    location.reload();

                  case 5:
                  case "end":
                    return _context3.stop();
                }
              }
            }, null, null, null, Promise);
          };

        case 5:
        case "end":
          return _context4.stop();
      }
    }
  }, null, null, null, Promise);
}

var RELA_NO = `

> ### 相关文档
  暂无
`;
var RELA_LS = `

> ### 相关文档
`;
var dd_ls_all = [];
var RAND_LS = `

> ### 随便看看
`;

function related(tags) {
  var o_qid, ls, ss;
  return regeneratorRuntime.async(function related$(_context5) {
    while (1) {
      switch (_context5.prev = _context5.next) {
        case 0:
          _context5.prev = 0;
          o_qid = qid;
          _context5.t0 = JSON;
          _context5.next = 5;
          return regeneratorRuntime.awrap(xhr('?id=' + o_qid + '&do=related&tags=' + encodeURIComponent(tags1.value)));

        case 5:
          _context5.t1 = _context5.sent;
          ls = _context5.t0.parse.call(_context5.t0, _context5.t1);

          if (!(qid !== o_qid)) {
            _context5.next = 9;
            break;
          }

          return _context5.abrupt("return");

        case 9:
          ss = ls.filter(function (a) {
            return a.id !== qid;
          });

          if (ss.length) {
            _context5.next = 14;
            break;
          }

          throw 1;

        case 14:
          return _context5.abrupt("return", RELA_LS + ss.map(function ({
            id,
            title
          }) {
            return `  1. [${title}](?id=${id})`;
          }).join('\n\n'));

        case 15:
          _context5.next = 19;
          break;

        case 17:
          _context5.prev = 17;
          _context5.t2 = _context5["catch"](0);

        case 19:
          return _context5.abrupt("return", RELA_NO);

        case 20:
        case "end":
          return _context5.stop();
      }
    }
  }, null, null, [[0, 17]], Promise);
}

function rand() {
  var r = {};

  for (var i = 0; i < 20; i++) {
    r[Math.random() * dd_ls_all.length | 0] = 1;
  }

  var ret = [];

  for (var a in r) {
    var x = dd_ls_all[a];
    if (!x || x.id === qid) continue;
    ret.push(x);
  }

  return RAND_LS + (ret.length ? ret.map(function ({
    id,
    title
  }) {
    return `  1. [${title}](?id=${id})`;
  }).join('\n\n') : `  暂无`);
}

function update_md(ee) {
  var val, padding, str, fixstr, htmlDiv, dc, p;
  return regeneratorRuntime.async(function update_md$(_context6) {
    while (1) {
      switch (_context6.prev = _context6.next) {
        case 0:
          val = inp.value;
          padding = '';

          if (LOGINED) {
            _context6.next = 10;
            break;
          }

          _context6.next = 5;
          return regeneratorRuntime.awrap(related());

        case 5:
          _context6.t0 = _context6.sent;
          _context6.next = 8;
          return regeneratorRuntime.awrap(rand());

        case 8:
          _context6.t1 = _context6.sent;
          padding = [_context6.t0, _context6.t1].join('\n\n');

        case 10:
          str = marked(val + padding);
          fixstr = calc_where('pad-text', str);

          if (fixstr) {
            _context6.next = 14;
            break;
          }

          return _context6.abrupt("return");

        case 14:
          htmlDiv = $('#content');
          htmlDiv.html(fixstr);

          try {
            dc = $('[data-cur]');
            htmlDiv[0].scrollTop += dc.offset().top - htmlDiv.offset().top - htmlDiv.height() / 2;
            p = dc.parent();

            if (!p.hasClass('focusit') && !p.is('code') && !p.is(htmlDiv)) {
              p.addClass('focusit');
              setTimeout(function (_) {
                return p.removeClass('focusit');
              }, 1e3);
            }

            dc.remove();
          } catch (e) {}

          document.title = curinp.value;

          if (!(ee === 1)) {
            _context6.next = 20;
            break;
          }

          return _context6.abrupt("return");

        case 20:
          sav1.className = 'show';
          save();

        case 22:
        case "end":
          return _context6.stop();
      }
    }
  }, null, null, null, Promise);
}

;
['change', 'keyup'].map(function (c) {
  return $(document).on(c, '#inp', update_md);
});
update_md(1);
$('#inp').on('scroll', function () {
  content.scrollTop = inp.scrollTop / (inp.scrollHeight - inp.offsetHeight) * content.scrollHeight;
});

onbeforeunload = function () {
  if (sav1.className === 'show') return '保存中请稍等';
};

function clip2str(items) {
  var a, _loop, i;

  return regeneratorRuntime.async(function clip2str$(_context7) {
    while (1) {
      switch (_context7.prev = _context7.next) {
        case 0:
          a = [''];

          _loop = function (i) {
            var t = items[i];
            var {
              kind,
              type
            } = t;
            if (kind === 'string') a.push(new Promise(function (r) {
              t.getAsString(function (any) {
                if (type.match(/html/)) {
                  var b = document.createElement('div');
                  b.innerHTML = any;
                  r(b.innerText);
                } else r(any);
              });
            }));
            if (kind === 'file' && type.match(/^image/)) a.push(new Promise(function (r) {
              var b = new FileReader();
              var ff = t.getAsFile();
              b.readAsArrayBuffer(ff);

              b.onload = function (e) {
                xhr('?id=' + qid + '&do=upimg&img=' + ff.name, 'POST', e.target.result).then(function (src) {
                  r('![' + ff.name + '](?do=loadimg&id=' + qid + '&img=' + src + ')');
                });
              };
            }));
          };

          for (i = 0; items && i < items.length; i++) {
            _loop(i);
          }

          _context7.next = 5;
          return regeneratorRuntime.awrap(Promise.all(a));

        case 5:
          return _context7.abrupt("return", _context7.sent.join(''));

        case 6:
        case "end":
          return _context7.stop();
      }
    }
  }, null, null, null, Promise);
}

$('#inp').on('paste', function _callee4(e) {
  var s, pv, ib, ie, ss;
  return regeneratorRuntime.async(function _callee4$(_context8) {
    while (1) {
      switch (_context8.prev = _context8.next) {
        case 0:
          e.preventDefault();
          _context8.next = 3;
          return regeneratorRuntime.awrap(clip2str(e.originalEvent.clipboardData.items));

        case 3:
          s = _context8.sent;
          pv = inp.value;
          ib = inp.selectionStart, ie = inp.selectionEnd;
          inp.value = ib === undefined || ie === undefined ? pv + s : pv.slice(0, ib) + s + pv.slice(ie, pv.length);
          $('#inp').change();
          ss = ib === undefined ? (pv + s).length : ib + s.length;
          inp.setSelectionRange(ss, ss, 1);
          inp.focus();
          return _context8.abrupt("return", false);

        case 12:
        case "end":
          return _context8.stop();
      }
    }
  }, null, null, null, Promise);
});

function update_dd_ls(dd_ls, has_last_dd) {
  dd_ls_all = dd_ls_all.concat(dd_ls);
  var str = '';

  for (var i = 0; i < dd_ls.length; i++) {
    var d1 = dd_ls[i];
    var n = new Date();
    n.setTime(d1.create_time);
    d1._cyear = n.getFullYear();
    d1._cmonth = n.getMonth() + 1;
    var dd_l = dd_ls[i - 1] || has_last_dd;

    if (!dd_l || dd_l._cyear !== d1._cyear || dd_l._cmonth !== d1._cmonth) {
      str += `<div class='date'>${d1._cyear}/${d1._cmonth < 10 ? '0' + d1._cmonth : d1._cmonth}</div>`;
    }

    str += `<span data-id="${d1.id}" class='dtitle ${d1.id === qid ? 'dtitle-active' : ''}'>${d1.title}
      <span class='del' data-id="${d1.id}" data-title="${d1.title}">删除</span>
    </span>`;
  }

  if (has_last_dd) lst.innerHTML += str;else lst.innerHTML = str || `<div class='empty'>没有内容</div>`;
}

search.onkeyup = simpledebounce(function _callee5(_) {
  var rr;
  return regeneratorRuntime.async(function _callee5$(_context9) {
    while (1) {
      switch (_context9.prev = _context9.next) {
        case 0:
          _context9.next = 2;
          return regeneratorRuntime.awrap(xhr('?id=' + qid + '&do=searchkw&kw=' + encodeURIComponent(search.value)));

        case 2:
          rr = _context9.sent;
          update_dd_ls(JSON.parse(rr));

        case 4:
        case "end":
          return _context9.stop();
      }
    }
  }, null, null, null, Promise);
}, 500);
$('#search').on('focus', function _callee6(_) {
  return regeneratorRuntime.async(function _callee6$(_context10) {
    while (1) {
      switch (_context10.prev = _context10.next) {
        case 0:
          _context10.next = 2;
          return regeneratorRuntime.awrap(sleep(500));

        case 2:
          $('.datelist').addClass('searchactive');

        case 3:
        case "end":
          return _context10.stop();
      }
    }
  }, null, null, null, Promise);
}).on('blur', function _callee7(_) {
  return regeneratorRuntime.async(function _callee7$(_context11) {
    while (1) {
      switch (_context11.prev = _context11.next) {
        case 0:
          _context11.next = 2;
          return regeneratorRuntime.awrap(sleep(500));

        case 2:
          $('.datelist').removeClass('searchactive');

        case 3:
        case "end":
          return _context11.stop();
      }
    }
  }, null, null, null, Promise);
});
update_dd_ls(menulst);

function refleshId(id) {
  var detail;
  return regeneratorRuntime.async(function refleshId$(_context12) {
    while (1) {
      switch (_context12.prev = _context12.next) {
        case 0:
          if (!(sav1.className === 'show')) {
            _context12.next = 2;
            break;
          }

          return _context12.abrupt("return", alert('保存中请稍等'));

        case 2:
          if (!IS_FOR_GITHUB_IO) {
            _context12.next = 5;
            break;
          }

          location = id + '.html';
          return _context12.abrupt("return");

        case 5:
          qid = id;
          _context12.prev = 6;
          history.pushState('', '', '?id=' + qid);
          $('.datelist-btn-close').click();
          _context12.t0 = JSON;
          _context12.next = 12;
          return regeneratorRuntime.awrap(xhr('?do=detail&id=' + id));

        case 12:
          _context12.t1 = _context12.sent;
          detail = _context12.t0.parse.call(_context12.t0, _context12.t1);
          $('.tabsr-title').html(detail.title);
          $('.tabsr-tags').html(detail.tags.length ? detail.tags.map(function (tag, i) {
            return `<span class="tagz" style="background: #${detail.ctags[i]}">${tag}</span>`;
          }).join('') : '无标签');
          curinp.value = detail.title;
          tags1.value = detail.tags.join(' ');

          $('.dellink')[0].onclick = function (_) {
            return del([qid, detail.title]);
          };

          $('.newlink')[0].href = '?id=' + randomId();
          inp.value = detail.content;
          update_md(1);
          $('.dtitle-active').removeClass('dtitle-active');
          $('.dtitle[data-id="' + qid + '"]').addClass('dtitle-active');
          _context12.next = 30;
          break;

        case 26:
          _context12.prev = 26;
          _context12.t2 = _context12["catch"](6);
          alert('已被删除');
          location = '?';

        case 30:
        case "end":
          return _context12.stop();
      }
    }
  }, null, null, [[6, 26]], Promise);
}

var th = false,
    has_last_dd = menulst[menulst.length - 1];
var dl = $('.datelist');
dl.on('scroll', simpledebounce(function (_) {
  if (dl[0].scrollTop + dl[0].offsetHeight >= dl[0].scrollHeight - 100) th = 1;
}, 3e2));

(function _callee8(_) {
  var page, dd_ls;
  return regeneratorRuntime.async(function _callee8$(_context13) {
    while (1) {
      switch (_context13.prev = _context13.next) {
        case 0:
          page = 2;

        case 1:
          _context13.next = 3;
          return regeneratorRuntime.awrap(sleep(1e3));

        case 3:
          if (!(!th && dl[0].scrollTop + dl[0].offsetHeight < dl[0].scrollHeight)) {
            _context13.next = 5;
            break;
          }

          return _context13.abrupt("continue", 21);

        case 5:
          _context13.prev = 5;
          _context13.t0 = JSON;
          _context13.next = 9;
          return regeneratorRuntime.awrap(xhr('?id=' + qid + '&do=ls&page=' + page));

        case 9:
          _context13.t1 = _context13.sent;
          dd_ls = _context13.t0.parse.call(_context13.t0, _context13.t1);

          if (dd_ls.length) {
            _context13.next = 13;
            break;
          }

          return _context13.abrupt("break", 23);

        case 13:
          update_dd_ls(dd_ls, has_last_dd);
          has_last_dd = dd_ls[dd_ls.length - 1];
          th = false;
          page++;
          _context13.next = 21;
          break;

        case 19:
          _context13.prev = 19;
          _context13.t2 = _context13["catch"](5);

        case 21:
          _context13.next = 1;
          break;

        case 23:
        case "end":
          return _context13.stop();
      }
    }
  }, null, null, [[5, 19]], Promise);
})();

$(document).on('click', '.tagz', function () {
  $('#search').val($(this).html()).keyup();
  $('.datelist-btn').click();
});
$(window).on('resize', function (_) {
  $(document.body).removeClass('win-min win-middle win-large');
  var s = innerWidth;
  var x = 'win-min';
  if (s > 920) x = 'win-middle';
  if (s > 1280) x = 'win-large';
  $(document.body).addClass(x);
}).resize();
$('.datelist-btn').on('click', function (_) {
  $('.datelist').addClass('show');
});
$('.datelist-btn-close').on('click', function (_) {
  $('.datelist').removeClass('show');
});
$(document).on('click', '.del[data-id]', function (e) {
  e.preventDefault();
  var t = $(this);
  del([t.attr('data-id'), t.attr('data-title')]);
  return false;
}).on('click', '.dtitle:not(.dtitle-active)', function (e) {
  e.preventDefault();
  refleshId($(this).attr('data-id'));
  return false;
});

function mkcode(id, str) {
  var qrcode = new QRCode(id, {
    text: str,
    width: 200,
    height: 200,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });
}

$(document).on('click', '.btn-gareset', function _callee9(_) {
  var rr;
  return regeneratorRuntime.async(function _callee9$(_context14) {
    while (1) {
      switch (_context14.prev = _context14.next) {
        case 0:
          if (confirm('确认要重置登录GA? ')) {
            _context14.next = 2;
            break;
          }

          return _context14.abrupt("return");

        case 2:
          $('.body-mask').css('display', 'block');
          _context14.t0 = JSON;
          _context14.next = 6;
          return regeneratorRuntime.awrap(xhr('?id=' + qid + '&do=resetga'));

        case 6:
          _context14.t1 = _context14.sent;
          rr = _context14.t0.parse.call(_context14.t0, _context14.t1);
          $('.resetga-div').css('display', 'block');
          mkcode(ga1sqr, rr[0]);
          mkcode(ga2sqr, rr[1]);
          ga1s.value = rr[0];
          ga2s.value = rr[1];

        case 13:
        case "end":
          return _context14.stop();
      }
    }
  }, null, null, null, Promise);
}).on('click', '.ga-done', function (_) {
  if (!confirm('确认录入完成刷新页面？')) return;
  location.reload();
});
$(document).on('click', '.tx.gaqr-2', function () {
  $('.resetga-div').removeClass('a1').addClass('a2');
}).on('click', '.tx.gaqr-1', function () {
  $('.resetga-div').removeClass('a2').addClass('a1');
});
$('.login').on('click', function _callee10(_) {
  var a, aa;
  return regeneratorRuntime.async(function _callee10$(_context15) {
    while (1) {
      switch (_context15.prev = _context15.next) {
        case 0:
          a = prompt('输入12位ga数字码', '');

          if (a.match(/^\d{12}$/)) {
            _context15.next = 3;
            break;
          }

          return _context15.abrupt("return", alert('格式错误'));

        case 3:
          _context15.next = 5;
          return regeneratorRuntime.awrap(xhr('?id=' + qid + '&do=ga&tokens=' + a));

        case 5:
          aa = _context15.sent;
          if (aa === 'yes') location.reload();else alert('登陆失败');

        case 7:
        case "end":
          return _context15.stop();
      }
    }
  }, null, null, null, Promise);
});
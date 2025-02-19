const SoundPubSub = require("soundpubsub").soundPubSub;
const CHAIN_CHANGED = 'chainChanged';
const WILDCARD = "*";
const CHAIN_SEPARATOR = ".";
const MODEL_PREFIX = "Model";
const ARRAY_CHANGE_METHODS = ['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'slice', 'sort', 'splice', 'unshift'];
const compactor = function(message, channel) {
    if (message.type === CHAIN_CHANGED) {
        return channel;
    }
};
SoundPubSub.registerCompactor(CHAIN_CHANGED, compactor);

let modelCounter = 0;

class PskBindableModel {

    static setModel(_model) {
        let root = undefined;
        let targetPrefix = MODEL_PREFIX + CHAIN_SEPARATOR + modelCounter + CHAIN_SEPARATOR;
        let observedChains = new Set();
        const expressions = {};

        modelCounter++;

        function extendChain(parentChain, currentChain) {
            return parentChain ? parentChain + CHAIN_SEPARATOR + currentChain : currentChain
        }

        function createChannelName(chain) {
            return targetPrefix + chain;
        }

        function makeSetter(parentChain) {
            return function(obj, prop, value) {
                let chain = extendChain(parentChain, prop);
                if (value && typeof value === "object") {
                    obj[prop] = proxify(value, chain);
                } else {
                    obj[prop] = value;
                }
                root.notify(chain);
                return true;
            }
        }

        function pushHandler(target, parentChain) {
            return function() {
                try {
                    let arrayLength = Array.prototype.push.apply(target, arguments);
                    let index = arrayLength - 1;
                    root.notify(extendChain(parentChain, index));
                    return arrayLength;
                } catch (e) {
                    console.log("An error occurred in Proxy");
                    throw e;
                }
            }
        }

        function arrayFnHandler(fn, target, parentChain) {
            return function() {
                try {
                    let returnedValue = Array.prototype[fn].apply(target, arguments);
                    if (ARRAY_CHANGE_METHODS.indexOf(fn) !== -1) {
                        root.notify(parentChain);
                    }
                    return returnedValue;
                } catch (e) {
                    console.log("An error occurred in Proxy");
                    throw e;
                }
            }
        }

        function makeArrayGetter(parentChain) {
            return function(target, prop) {
                const val = target[prop];
                if (typeof val === 'function') {
                    switch (prop) {
                        case "push":
                            return pushHandler(target, parentChain);
                        default:
                            return arrayFnHandler(prop, target, parentChain);
                    }
                }
                return val;
            }
        }

        function proxify(obj, parentChain) {

            if (typeof obj !== "object") {
                return obj;
            }

            let isRoot = !parentChain;
            let notify, onChange, getChainValue, setChainValue;
            if (isRoot) {
                notify = function(changedChain) {

                    function getRelatedChains(changedChain) {
                        let chainsRelatedSet = new Set();
                        chainsRelatedSet.add(WILDCARD);
                        let chainSequence = changedChain.split(CHAIN_SEPARATOR).map(el => el.trim());

                        let chainPrefix = "";
                        for (let i = 0; i < chainSequence.length; i++) {
                            if (i !== 0) {
                                chainPrefix += CHAIN_SEPARATOR + chainSequence[i];
                            } else {
                                chainPrefix = chainSequence[i];
                            }
                            chainsRelatedSet.add(chainPrefix);
                        }

                        observedChains.forEach((chain) => {
                            if (chain.startsWith(changedChain)) {
                                chainsRelatedSet.add(chain);
                            }
                        });

                        return chainsRelatedSet;
                    }

                    let changedChains = getRelatedChains(changedChain);

                    changedChains.forEach(changedChain => {
                        SoundPubSub.publish(createChannelName(changedChain), {
                            type: CHAIN_CHANGED,
                            chain: changedChain
                        });
                    })
                };

                getChainValue = function(chain) {

                    if (!chain) {
                        return root;
                    }

                    let chainSequence = chain.split(CHAIN_SEPARATOR).map(el => el.trim());
                    let reducer = (accumulator, currentValue) => {
                        if (accumulator !== null && typeof accumulator !== 'undefined') {
                            return accumulator[currentValue];
                        }
                        return undefined;
                    };
                    return chainSequence.reduce(reducer, root);
                };

                setChainValue = function(chain, value) {
                    let chainSequence = chain.split(CHAIN_SEPARATOR).map(el => el.trim());

                    let reducer = (accumulator, currentValue, index, array) => {
                        if (accumulator !== null && typeof accumulator !== 'undefined') {
                            if (index === array.length - 1) {
                                accumulator[currentValue] = value;
                                return true;
                            }
                            accumulator = accumulator[currentValue];
                            return accumulator;
                        }
                        return undefined;
                    };
                    return chainSequence.reduce(reducer, root);
                };

                onChange = function(chain, callback) {
                    observedChains.add(chain);
                    SoundPubSub.subscribe(createChannelName(chain), callback);
                }
            }
            let setter = makeSetter(parentChain);

            let handler = {
                apply: function(target, prop, argumentsList) {
                    throw new Error("A function call was not expected inside proxy!");
                },
                constructor: function(target, args) {
                    throw new Error("A constructor call was not expected inside proxy!");
                },
                isExtensible: function(target) {
                    return Reflect.isExtensible(target);
                },
                preventExtensions: function(target) {
                    return Reflect.preventExtensions(target);
                },
                get: function(obj, prop) {
                    if (isRoot) {
                        switch (prop) {
                            case "onChange":
                                return onChange;
                            case "notify":
                                return notify;
                            case "getChainValue":
                                return getChainValue;
                            case "setChainValue":
                                return setChainValue;
                        }
                    }

                    return obj[prop];
                },
                set: makeSetter(parentChain),

                deleteProperty: function(oTarget, sKey) {
                    delete oTarget[sKey];
                },

                ownKeys: function(oTarget) {
                    return Reflect.ownKeys(oTarget);
                },
                has: function(oTarget, sKey) {
                    return sKey in oTarget
                },
                defineProperty: function(oTarget, sKey, oDesc) {
                    let oDescClone = Object.assign({}, oDesc);
                    oDescClone.set = function(obj, prop, value) {
                        if (oDesc.hasOwnProperty("set")) {
                            oDesc.set(obj, prop, value);
                        }
                        setter(obj, prop, value);
                    };
                    return Object.defineProperty(oTarget, sKey, oDescClone);
                },
                getOwnPropertyDescriptor: function(oTarget, sKey) {
                    return Object.getOwnPropertyDescriptor(oTarget, sKey)
                },
                getPrototypeOf: function(target) {
                    return Reflect.getPrototypeOf(target)
                },
                setPrototypeOf: function(target, newProto) {
                    Reflect.setPrototypeOf(target, newProto);
                }
            };

            if (Array.isArray(obj)) {
                handler.get = makeArrayGetter(parentChain);
            }

            //proxify inner objects
            Object.keys(obj).forEach(prop => {
                if (obj[prop]) {
                    obj[prop] = proxify(obj[prop], extendChain(parentChain, prop));
                }
            });

            return new Proxy(obj, handler);
        }

        root = proxify(_model);

        /**
         * This function is returning the object representanion of the proxified model.
         * It accepts only one optional parameter, chain.
         * If no chain is provided, the root model becomes the source.
         * 
         * @param {string | null} chain - (Optional) The chain inside the root model.
         * @returns {Object} - The object representanion of the proxified model
         */
        root.toObject = function(chain) {
            let source = {};

            if (!chain) {
                source = root;
            } else if (typeof chain === 'string') {
                source = root.getChainValue(chain);
            }

            if (source && typeof source === 'object') {
                return JSON.parse(JSON.stringify(source));
            }

            return source;
        }

        ////////////////////////////
        // Model expressions support
        ////////////////////////////
        /**
         * @param {string} expressionName
         * @param {callback} callback
         * @param {...string} var_args Variable number of chains to watch. First argument can be an array of chains
         * @throws {Error}
         */
        root.addExpression = function(expressionName, callback, ...args) {
            if (typeof expressionName !== 'string' || !expressionName.length) {
                throw new Error("Expression name must be a valid string");
            }

            if (typeof callback !== 'function') {
                throw new Error("Expression must have a callback");
            }

            let watchChain = [];
            if (args.length) {
                let chainList = args;

                if (Array.isArray(chainList[0])) {
                    chainList = chainList[0];
                }

                watchChain = chainList.filter((chain) => {
                    return typeof chain === 'string' && chain.length;
                });
            }

            expressions[expressionName] = {
                watchChain,
                callback: function() {
                    return callback.call(root);
                }
            }
        }

        /**
         * @param {string} expressionName
         * @return {mixed}
         * @throws {Error}
         */
        root.evaluateExpression = function(expressionName) {
            if (!this.hasExpression(expressionName)) {
                throw new Error(`Expression "${expressionName}" is not defined`);
            }

            return expressions[expressionName].callback();
        }

        /**
         * @param {string} expressionName
         * @return {boolean}
         */
        root.hasExpression = function(expressionName) {
            if (typeof expressions[expressionName] === 'object' &&
                typeof expressions[expressionName].callback === 'function') {
                return true;
            }
            return false;
        }

        /**
         * Watch expression chains
         *
         * @param {string} expressionName
         * @param {callback} callback
         */
        root.onChangeExpressionChain = function(expressionName, callback) {
            if (!this.hasExpression(expressionName)) {
                throw new Error(`Expression "${expressionName}" is not defined`);
            }

            const expr = expressions[expressionName];

            if (!expr.watchChain.length) {
                return;
            }

            for (let i = 0; i < expr.watchChain.length; i++) {
                this.onChange(expr.watchChain[i], callback);
            }
        }

        return root;
    }
}

module.exports = PskBindableModel;
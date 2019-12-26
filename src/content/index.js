// NOTE: Modules are not supported.
// TODO: Use bundler.

/** @typedef {import('../background/storage').UserSettings} UserSettings */

const messenger = (() => {
    const port = chrome.runtime.connect({name: 'tab'});
    port.onMessage.addListener(({type, data}) => {
        listeners
            .get(type)
            .forEach((listener) => listener(data));
    });
    port.onDisconnect.addListener(() => {
        disconnectListeners.forEach((cb) => cb());
    });

    /**
     * @param {string} type
     * @param {any} data
     */
    function send(type, data) {
        if (!port) {
            console.log('no port');
            return;
        }
        port.postMessage({type, data});
    }

    /** @type {Map<string, Set<(data: any) => void>>} */
    const listeners = new Map();

    /**
     * @param {string} type
     * @param {(data: any) => void} callback
     */
    function on(type, callback) {
        if (!listeners.has(type)) {
            listeners.set(type, new Set());
        }
        listeners.get(type).add(callback);
    }

    /**
     * @param {string} type
     * @param {(data: any) => void} callback
     */
    function off(type, callback) {
        if (listeners.has(type)) {
            listeners.get(type).delete(callback);
        }
    }

    const disconnectListeners = new Set();

    /**
     * @param {() => void} callback
     */
    function onDisconnect(callback) {
        disconnectListeners.add(callback);
    }

    return {
        on,
        off,
        send,
        onDisconnect,
    };
})();

const textManager = (() => {
    const cyrillicCharRegexp = new RegExp(
        /[\u0401\u0406\u040e\u0410-\u044f\u0451\u0456\u045e\u04e2\u04e3]/
    );

    const beCharRegexp = new RegExp(
        /[\u0401\u0406\u045e\u04e2]/
    );

    /**
     * @param {string} text
     * @returns {boolean}
     */
    function hasCyrillicChars(text) {
        return cyrillicCharRegexp.test(text);
    }

    /**
     * @param {string} text
     * @returns {boolean}
     */
    function hasBelarusianChars(text) {
        return beCharRegexp.test(text);
    }

    /** @type {WeakSet<Text>} */
    let handledTextNodes;
    /** @type {WeakMap<Text, string>} */
    const sourceTexts = new WeakMap();
    let counter = 0;

    /** @type {Map<number, Text>} */
    const waitingNodes = new Map();

    /**
     * @param {Text} node
     * @param {boolean} force
     */
    function tryTranslateNode(node, force = false) {
        if (!force && handledTextNodes.has(node)) {
            return;
        }
        handledTextNodes.add(node);

        const text = node.textContent;
        if (!text.trim()) {
            return;
        }

        const isCyrillic = hasCyrillicChars(text);
        if (isCyrillic) {
            const isBelarusian = hasBelarusianChars(text);
            const id = counter++;
            waitingNodes.set(id, node);
            messenger.send(
                isBelarusian ? 'transliterate' : 'translate',
                {id, text},
            );
        }
    }

    /**
     * @param {Text} node
     */
    function restoreNode(node) {
        if (sourceTexts.has(node)) {
            node.textContent = sourceTexts.get(node);
        }
    }

    messenger.on('done', ({id, text}) => {
        const node = waitingNodes.get(id);
        waitingNodes.delete(id);
        if (text != null) {
            sourceTexts.set(node, node.textContent);
            node.textContent = text;
        }
    });

    /** @type {WeakSet<Node>} */
    let walkedNodes = new WeakSet();

    /**
     * @param {Node} root
     * @param {(node: Text) => void} callback
     */
    function walkTextNodes(root, callback) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);

        /** @type {Text} */
        let node;
        while (node = /** @type {Text} */(walker.nextNode())) {
            const parentName = node.parentNode.nodeName;
            if (
                parentName === 'SCRIPT' ||
                parentName === 'STYLE' ||
                walkedNodes.has(node)
            ) {
                continue;
            }

            walkedNodes.add(node);
            callback(node);
        }
    }

    /** @type {MutationObserver} */
    let observer;

    /**
     * @param {MutationRecord[]} mutations
     */
    function handleMutations(mutations) {
        mutations.forEach(({target, addedNodes}) => {
            if (target.nodeType === Node.TEXT_NODE) {
                tryTranslateNode(/** @type {Text} */(target), true);
            }
            addedNodes.forEach((node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    tryTranslateNode(/** @type {Text} */(node));
                } else {
                    walkTextNodes(node, tryTranslateNode);
                }
            });
            observer.takeRecords();
        });
    }

    function translateAndWatch() {
        observer && observer.disconnect();
        handledTextNodes = new WeakSet();
        walkedNodes = new WeakSet();

        walkTextNodes(document.documentElement, tryTranslateNode);
        observer = new MutationObserver(handleMutations);
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
        });
    }

    function stopAndRestore() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        handledTextNodes = new WeakSet();
        walkedNodes = new WeakSet();

        walkTextNodes(document.documentElement, restoreNode);
    }

    return {
        translateAndWatch,
        stopAndRestore,
    };
})();

messenger.on('app-settings', (/** @type {UserSettings} */settings) => {
    try {
        const topHost = window.top.location.host;
        if (!topHost) {
            return;
        }

        const isEnabled = settings.enabledByDefault ?
            !settings.disabledFor.includes(topHost) :
            settings.enabledFor.includes(topHost);

        if (isEnabled) {
            textManager.translateAndWatch();
        } else {
            textManager.stopAndRestore();
        }
    } catch (err) {
    }
});

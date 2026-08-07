/* Water shop NUI.
 *
 * The page renders whatever catalogue the server sent and reports what the
 * player clicked. It never decides an outcome: prices shown here are for
 * display, and every purchase is confirmed by a `result` message coming back
 * from the server.
 */
(function () {
    'use strict';

    var RESOURCE = (typeof window.GetParentResourceName === 'function')
        ? window.GetParentResourceName()
        : window.location.hostname.replace(/^cfx-nui-/, '');

    var PURCHASE_TIMEOUT_MS = 8000;

    var state = {
        open: false,
        currency: '$',
        balance: 0,
        items: [],
        selectedId: null,
        quantity: 1,
        pending: null,          // { txId, timer }
    };

    var el = {};
    [
        'scrim', 'shopLocation', 'walletLabel', 'walletValue', 'closeBtn',
        'catalogGrid', 'checkoutEmpty', 'order', 'orderArt', 'orderLabel', 'orderDetail',
        'qtyMinus', 'qtyPlus', 'qtyValue', 'unitPrice', 'ownedCount', 'totalPrice',
        'buyBtn', 'buyLabel', 'buyHint', 'toasts', 'stockNote', 'shopTitle',
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    // ---------------------------------------------------------------- utils

    function post(name, data) {
        return fetch('https://' + RESOURCE + '/' + name, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(data || {}),
        }).catch(function () { /* the game closed the frame; nothing to do */ });
    }

    function money(amount) {
        return state.currency + Number(amount || 0).toLocaleString('en-US');
    }

    function newTxId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        var bytes = new Uint8Array(16);
        (window.crypto || {}).getRandomValues
            ? window.crypto.getRandomValues(bytes)
            : bytes.forEach(function (_, i) { bytes[i] = Math.floor(Math.random() * 256); });
        return Array.prototype.map.call(bytes, function (b) {
            return ('0' + b.toString(16)).slice(-2);
        }).join('');
    }

    function findItem(id) {
        for (var i = 0; i < state.items.length; i++) {
            if (state.items[i].id === id) return state.items[i];
        }
        return null;
    }

    /** Largest quantity the shelf allows for this line, ignoring the wallet. */
    function maxQuantity(item) {
        if (!item) return 1;
        var max = item.maxPerPurchase || 1;
        if (item.limited) max = Math.min(max, item.stock || 0);
        return Math.max(1, max);
    }

    function isSoldOut(item) {
        return !!item && item.limited && !item.stock;
    }

    // ------------------------------------------------------------------ art

    var ART = {
        still:
            '<svg viewBox="0 0 40 64" aria-hidden="true">' +
            '<rect x="15" y="1" width="10" height="6" rx="1.6" fill="#57d6ff"/>' +
            '<path d="M16 7h8v5.2c0 1.2.6 2.3 1.6 3 2.7 1.9 4.4 5 4.4 8.4V56a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V23.6c0-3.4 1.7-6.5 4.4-8.4a3.7 3.7 0 0 0 1.6-3V7Z" fill="rgba(87,214,255,.13)" stroke="rgba(150,225,255,.55)" stroke-width="1.4"/>' +
            '<path d="M11 34h18v22a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 11 56V34Z" fill="rgba(87,214,255,.4)"/>' +
            '<rect x="12.6" y="38" width="14.8" height="9" rx="1.6" fill="rgba(233,244,251,.17)"/>' +
            '</svg>',

        sparkling:
            '<svg viewBox="0 0 40 64" aria-hidden="true">' +
            '<rect x="15" y="1" width="10" height="6" rx="1.6" fill="#57d6ff"/>' +
            '<path d="M16 7h8v5.2c0 1.2.6 2.3 1.6 3 2.7 1.9 4.4 5 4.4 8.4V56a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V23.6c0-3.4 1.7-6.5 4.4-8.4a3.7 3.7 0 0 0 1.6-3V7Z" fill="rgba(87,214,255,.13)" stroke="rgba(150,225,255,.55)" stroke-width="1.4"/>' +
            '<path d="M11 32h18v24a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 11 56V32Z" fill="rgba(87,214,255,.4)"/>' +
            '<g fill="rgba(240,252,255,.75)">' +
            '<circle cx="16" cy="38" r="1.7"/><circle cx="23.5" cy="43" r="2.1"/>' +
            '<circle cx="18" cy="48" r="1.4"/><circle cx="24" cy="53" r="1.6"/>' +
            '<circle cx="15.5" cy="55" r="1.1"/>' +
            '</g>' +
            '</svg>',

        pack:
            '<svg viewBox="0 0 40 64" aria-hidden="true">' +
            '<g fill="rgba(87,214,255,.45)">' +
            '<rect x="7" y="14" width="6" height="12" rx="2"/>' +
            '<rect x="17" y="10" width="6" height="16" rx="2"/>' +
            '<rect x="27" y="14" width="6" height="12" rx="2"/>' +
            '</g>' +
            '<g fill="#57d6ff">' +
            '<rect x="7" y="11" width="6" height="4" rx="1.4"/>' +
            '<rect x="17" y="7" width="6" height="4" rx="1.4"/>' +
            '<rect x="27" y="11" width="6" height="4" rx="1.4"/>' +
            '</g>' +
            '<path d="M5 24h30v32a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V24Z" fill="rgba(87,214,255,.2)" stroke="rgba(150,225,255,.5)" stroke-width="1.4"/>' +
            '<path d="M5.6 34h28.8" stroke="rgba(150,225,255,.32)" stroke-width="1.2"/>' +
            '<text x="20" y="51" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" fill="rgba(233,244,251,.8)">6</text>' +
            '</svg>',

        glacier:
            '<svg viewBox="0 0 40 64" aria-hidden="true">' +
            '<rect x="15" y="1" width="10" height="5" rx="1.4" fill="#57d6ff"/>' +
            '<path d="M16 6h8v4.4c0 1.3.7 2.5 1.8 3.2 2.9 1.9 4.7 5.2 4.7 8.8V57a4.5 4.5 0 0 1-4.5 4.5h-12A4.5 4.5 0 0 1 9.5 57V22.4c0-3.6 1.8-6.9 4.7-8.8a3.9 3.9 0 0 0 1.8-3.2V6Z" fill="rgba(87,214,255,.12)" stroke="rgba(150,225,255,.6)" stroke-width="1.4"/>' +
            '<rect x="11" y="30" width="18" height="16" rx="2" fill="rgba(233,244,251,.13)" stroke="rgba(150,225,255,.34)" stroke-width="1"/>' +
            '<path d="M13.4 42.4l4.3-6.6 3 4.3 2.2-3.1 3.7 5.4H13.4Z" fill="rgba(150,225,255,.82)"/>' +
            '</svg>',
    };

    function artFor(item) {
        return ART[item && item.art] || ART.still;
    }

    // --------------------------------------------------------------- render

    function renderCatalog() {
        el.catalogGrid.textContent = '';

        state.items.forEach(function (item) {
            var card = document.createElement('button');
            card.type = 'button';
            card.className = 'card';
            card.setAttribute('role', 'radio');
            card.dataset.id = item.id;

            var soldOut = isSoldOut(item);
            card.disabled = soldOut;
            card.setAttribute('aria-checked', String(item.id === state.selectedId));
            if (item.id === state.selectedId) card.classList.add('is-selected');

            var art = document.createElement('span');
            art.className = 'card__art';
            art.innerHTML = artFor(item);

            var label = document.createElement('p');
            label.className = 'card__label';
            label.textContent = item.label;

            var foot = document.createElement('span');
            foot.className = 'card__foot';

            var price = document.createElement('span');
            price.className = 'card__price';
            price.textContent = money(item.price);
            foot.appendChild(price);

            if (item.limited) {
                var tag = document.createElement('span');
                var left = item.stock || 0;
                tag.className = 'tag ' + (left === 0 ? 'tag--out' : (left <= 5 ? 'tag--low' : 'tag--stock'));
                tag.textContent = left === 0 ? 'Sold out' : left + ' left';
                foot.appendChild(tag);
            }

            card.appendChild(art);
            card.appendChild(label);
            card.appendChild(foot);
            card.addEventListener('click', function () { select(item.id); });

            el.catalogGrid.appendChild(card);
        });
    }

    function renderOrder() {
        var item = findItem(state.selectedId);
        var has = !!item;

        el.checkoutEmpty.hidden = has;
        el.order.hidden = !has;
        if (!has) return;

        el.orderArt.innerHTML = artFor(item);
        el.orderLabel.textContent = item.label;
        el.orderDetail.textContent = item.detail || '';

        var max = maxQuantity(item);
        var total = item.price * state.quantity;
        var affordable = total <= state.balance;
        var pending = !!state.pending;

        el.qtyValue.textContent = String(state.quantity);
        el.qtyMinus.disabled = pending || state.quantity <= 1;
        el.qtyPlus.disabled = pending || state.quantity >= max;

        el.unitPrice.textContent = money(item.price);
        el.ownedCount.textContent = String(item.owned || 0);
        el.totalPrice.textContent = money(total);

        el.buyBtn.classList.toggle('is-pending', pending);
        el.buyBtn.disabled = pending || !affordable || isSoldOut(item);
        el.buyLabel.textContent = pending ? 'Working' : 'Buy for ' + money(total);

        if (pending) {
            setHint('', false);
        } else if (isSoldOut(item)) {
            setHint('This line is sold out.', true);
        } else if (!affordable) {
            setHint('You need ' + money(total - state.balance) + ' more.', true);
        } else if (state.quantity >= max) {
            setHint(item.limited && max === (item.stock || 0)
                ? 'That is all the stock there is.'
                : 'Maximum ' + max + ' per purchase.', false);
        } else {
            setHint('', false);
        }
    }

    function renderWallet(previousBalance) {
        el.walletValue.textContent = money(state.balance);
        if (previousBalance !== undefined && previousBalance !== state.balance) {
            el.walletValue.classList.remove('is-bump');
            void el.walletValue.offsetWidth;     // restart the animation
            el.walletValue.classList.add('is-bump');
        }
    }

    function renderStockNote() {
        var limited = state.items.filter(function (i) { return i.limited; });
        if (!limited.length) {
            el.stockNote.textContent = '';
            return;
        }
        el.stockNote.textContent = limited.map(function (i) {
            return i.label + ': ' + (i.stock || 0) + ' in stock';
        }).join('  ·  ');
    }

    function setHint(text, bad) {
        el.buyHint.textContent = text;
        el.buyHint.classList.toggle('is-bad', !!bad);
    }

    function renderAll(previousBalance) {
        renderCatalog();
        renderOrder();
        renderWallet(previousBalance);
        renderStockNote();
    }

    // ------------------------------------------------------------ behaviour

    function select(id) {
        if (state.pending) return;
        var item = findItem(id);
        if (!item || isSoldOut(item)) return;

        state.selectedId = id;
        state.quantity = Math.min(state.quantity, maxQuantity(item));
        if (state.quantity < 1) state.quantity = 1;
        renderAll();
    }

    function setQuantity(next) {
        var item = findItem(state.selectedId);
        if (!item || state.pending) return;
        state.quantity = Math.min(Math.max(1, next), maxQuantity(item));
        renderOrder();
    }

    function toast(message, ok) {
        var node = document.createElement('div');
        node.className = 'toast ' + (ok ? 'toast--ok' : 'toast--bad');

        var dot = document.createElement('span');
        dot.className = 'toast__dot';
        var text = document.createElement('span');
        text.textContent = message;

        node.appendChild(dot);
        node.appendChild(text);
        el.toasts.appendChild(node);

        setTimeout(function () {
            node.classList.add('is-leaving');
            setTimeout(function () {
                if (node.parentNode) node.parentNode.removeChild(node);
            }, 240);
        }, 2600);
    }

    function clearPending() {
        if (state.pending && state.pending.timer) clearTimeout(state.pending.timer);
        state.pending = null;
    }

    function buy() {
        var item = findItem(state.selectedId);
        if (!item || state.pending || isSoldOut(item)) return;
        if (item.price * state.quantity > state.balance) return;

        var txId = newTxId();
        state.pending = {
            txId: txId,
            // If the server never answers, the button must not stay stuck.
            timer: setTimeout(function () {
                clearPending();
                renderOrder();
                toast('The register did not answer. Try again.', false);
            }, PURCHASE_TIMEOUT_MS),
        };

        renderOrder();
        post('purchase', { txId: txId, itemId: item.id, quantity: state.quantity });
    }

    function close() {
        if (!state.open) return;
        state.open = false;
        clearPending();

        el.scrim.classList.add('is-closing');
        setTimeout(function () {
            el.scrim.hidden = true;
            el.scrim.classList.remove('is-closing');
        }, 140);

        post('close', {});
    }

    // ------------------------------------------------------------- messages

    function onOpen(data) {
        state.open = true;
        clearPending();
        state.currency = data.currency || '$';
        state.balance = Number(data.balance) || 0;
        state.items = Array.isArray(data.items) ? data.items : [];
        state.quantity = 1;

        var first = null;
        for (var i = 0; i < state.items.length; i++) {
            if (!isSoldOut(state.items[i])) { first = state.items[i].id; break; }
        }
        state.selectedId = first;

        el.shopTitle.textContent = data.shopName || 'Water Shop';
        el.shopLocation.textContent = data.location || '';
        el.walletLabel.textContent = data.moneyLabel || 'Cash';

        el.scrim.classList.remove('is-closing');
        el.scrim.hidden = false;
        renderAll();
    }

    function onResult(data) {
        // A late answer to a transaction we already gave up on is ignored, so
        // it cannot re-enable a button belonging to a newer attempt.
        if (!state.pending || state.pending.txId !== data.txId) return;
        clearPending();

        var previousBalance = state.balance;
        if (typeof data.balance === 'number') state.balance = data.balance;
        if (Array.isArray(data.items)) state.items = data.items;

        var item = findItem(state.selectedId);
        if (item) state.quantity = Math.min(state.quantity, maxQuantity(item));

        toast(data.ok ? 'Bought ' + data.message : data.message, !!data.ok);
        renderAll(previousBalance);
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || typeof data.action !== 'string') return;

        if (data.action === 'open') onOpen(data);
        else if (data.action === 'close') {
            state.open = false;
            clearPending();
            el.scrim.hidden = true;
            el.scrim.classList.remove('is-closing');
        }
        else if (data.action === 'result') onResult(data);
    });

    // ----------------------------------------------------------------- wire

    el.closeBtn.addEventListener('click', close);
    el.buyBtn.addEventListener('click', buy);
    el.qtyMinus.addEventListener('click', function () { setQuantity(state.quantity - 1); });
    el.qtyPlus.addEventListener('click', function () { setQuantity(state.quantity + 1); });

    el.scrim.addEventListener('mousedown', function (event) {
        if (event.target === el.scrim) close();
    });

    document.addEventListener('keydown', function (event) {
        if (!state.open) return;

        if (event.key === 'Escape' || event.key === 'Backspace') {
            event.preventDefault();
            close();
        } else if (event.key === 'ArrowUp' || event.key === '+') {
            event.preventDefault();
            setQuantity(state.quantity + 1);
        } else if (event.key === 'ArrowDown' || event.key === '-') {
            event.preventDefault();
            setQuantity(state.quantity - 1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            buy();
        }
    });
}());

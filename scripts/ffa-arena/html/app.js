/* ffa-arena :: NUI scoreboard.
   Purely a HUD -- it never takes NUI focus, so it cannot steal the mouse or the keyboard.
   The client sends: show, state, scores, dead, alive, protection, banner. */

(function () {
    'use strict';

    var root = document.getElementById('root');
    var rowsEl = document.getElementById('rows');
    var emptyEl = document.getElementById('empty');
    var arenaEl = document.getElementById('arena-name');
    var goalEl = document.getElementById('goal');
    var protEl = document.getElementById('protection');
    var deadEl = document.getElementById('dead');
    var deadCount = document.getElementById('dead-count');
    var deadFill = document.getElementById('dead-fill');
    var bannerEl = document.getElementById('banner');
    var bannerTitle = document.getElementById('banner-title');
    var bannerSub = document.getElementById('banner-sub');

    var youId = -1;
    var deadTimer = null;
    var protTimer = null;
    var bannerTimer = null;

    function kd(kills, deaths) {
        if (!deaths) return kills.toFixed(2);
        return (kills / deaths).toFixed(2);
    }

    function render(rows) {
        rows = rows || [];
        rowsEl.innerHTML = '';
        emptyEl.classList.toggle('hidden', rows.length > 0);

        rows.forEach(function (r, i) {
            var li = document.createElement('li');
            li.className = 'row';
            if (r.id === youId) li.classList.add('you');
            if (i === 0 && r.kills > 0) li.classList.add('lead');

            var rank = document.createElement('span');
            rank.className = 'c-rank';
            rank.textContent = i + 1;

            var name = document.createElement('span');
            name.className = 'c-name';
            name.textContent = r.name;

            var k = document.createElement('span');
            k.className = 'c-num kills';
            k.textContent = r.kills;

            var d = document.createElement('span');
            d.className = 'c-num deaths';
            d.textContent = r.deaths;

            var ratio = document.createElement('span');
            ratio.className = 'c-num kd';
            ratio.textContent = kd(r.kills, r.deaths);

            li.appendChild(rank);
            li.appendChild(name);
            li.appendChild(k);
            li.appendChild(d);
            li.appendChild(ratio);
            rowsEl.appendChild(li);
        });
    }

    function startDeadCountdown(ms) {
        clearInterval(deadTimer);
        var end = Date.now() + ms;
        deadEl.classList.remove('hidden');

        function tick() {
            var left = Math.max(0, end - Date.now());
            deadCount.textContent = (left / 1000).toFixed(1);
            deadFill.style.width = (left / ms * 100) + '%';
            if (left <= 0) clearInterval(deadTimer);
        }
        tick();
        deadTimer = setInterval(tick, 60);
    }

    function showBanner(title, sub, ms) {
        clearTimeout(bannerTimer);
        bannerTitle.textContent = title || '';
        bannerSub.textContent = sub || '';
        bannerEl.classList.remove('hidden');
        bannerTimer = setTimeout(function () {
            bannerEl.classList.add('hidden');
        }, ms || 4000);
    }

    var handlers = {
        show: function (d) {
            root.classList.toggle('hidden', !d.show);
            if (!d.show) {
                deadEl.classList.add('hidden');
                protEl.classList.add('hidden');
                bannerEl.classList.add('hidden');
                clearInterval(deadTimer);
            }
        },
        state: function (d) {
            youId = typeof d.you === 'number' ? d.you : youId;
            if (d.arena) arenaEl.textContent = d.arena;
            if (d.goal) goalEl.textContent = 'First to ' + d.goal + ' kills';
        },
        scores: function (d) {
            render(d.rows);
        },
        dead: function (d) {
            startDeadCountdown(d.ms || 4000);
        },
        alive: function () {
            deadEl.classList.add('hidden');
            clearInterval(deadTimer);
        },
        protection: function (d) {
            clearTimeout(protTimer);
            protEl.classList.remove('hidden');
            protTimer = setTimeout(function () {
                protEl.classList.add('hidden');
            }, d.ms || 3000);
        },
        banner: function (d) {
            showBanner(d.title, d.sub, d.ms);
        }
    };

    window.addEventListener('message', function (event) {
        var d = event.data || {};
        var fn = handlers[d.action];
        if (fn) fn(d);
    });

    // Exposed so the state can be inspected from outside without touching the game.
    window.ffaDebugState = function () {
        return {
            visible: !root.classList.contains('hidden'),
            you: youId,
            arena: arenaEl.textContent,
            goal: goalEl.textContent,
            rows: Array.prototype.map.call(rowsEl.children, function (li) {
                return {
                    rank: li.children[0].textContent,
                    name: li.children[1].textContent,
                    kills: li.children[2].textContent,
                    deaths: li.children[3].textContent,
                    kd: li.children[4].textContent,
                    you: li.classList.contains('you')
                };
            }),
            dead: !deadEl.classList.contains('hidden'),
            protection: !protEl.classList.contains('hidden'),
            banner: !bannerEl.classList.contains('hidden') ? bannerTitle.textContent : null
        };
    };
})();

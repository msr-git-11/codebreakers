const cfg = window.CODEBREAKERS_CONFIG;

let sb = null;
let sessionUser = null;

let roomId =
  sessionStorage.getItem("cb_room_id") || null;

let roomCode =
  sessionStorage.getItem("cb_room_code") || null;

let room = null;
let players = [];
let me = null;
let secretKey = null;

let channel = null;

let syncTimer = null;
let guessTimerId = null;

let syncInProgress = false;
let actionInFlight = false;
let timerExpiryInFlight = false;

let lastServerUpdatedAt = null;

const $ = id =>
  document.getElementById(id);


/* =========================================================
   BASIC HELPERS
========================================================= */

function esc(value) {

  return String(value ?? "")
    .replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));

}


function notify(message) {

  const toast = $("toast");

  if (!toast) {
    alert(message);
    return;
  }

  toast.textContent = message;

  toast.classList.add("show");

  clearTimeout(
    notify.timer
  );

  notify.timer =
    setTimeout(() => {

      toast.classList.remove("show");

    }, 3000);

}


function setError(
  id,
  message = ""
) {

  const el = $(id);

  if (el) {
    el.textContent = message;
  }

}


function saveRoom(
  id,
  code
) {

  roomId = id;
  roomCode = code;

  sessionStorage.setItem(
    "cb_room_id",
    id
  );

  sessionStorage.setItem(
    "cb_room_code",
    code
  );

}


function clearRoom() {

  stopGuessTimer();
  stopBackupSync();

  if (channel && sb) {

    sb.removeChannel(
      channel
    );

  }

  channel = null;

  roomId = null;
  roomCode = null;

  room = null;
  players = [];
  me = null;
  secretKey = null;

  lastServerUpdatedAt = null;

  sessionStorage.removeItem(
    "cb_room_id"
  );

  sessionStorage.removeItem(
    "cb_room_code"
  );

}


function show(view) {

  [
    "home",
    "lobby",
    "game"
  ].forEach(id => {

    const element = $(id);

    if (element) {

      element.classList.toggle(
        "hidden",
        id !== view
      );

    }

  });

}


/* =========================================================
   SUPABASE
========================================================= */

function validateConfig() {

  if (!cfg) {

    throw new Error(
      "config.js was not loaded."
    );

  }


  if (
    !cfg.SUPABASE_URL ||
    cfg.SUPABASE_URL.includes(
      "YOUR-PROJECT"
    )
  ) {

    throw new Error(
      "Supabase URL is missing."
    );

  }


  if (
    !cfg.SUPABASE_ANON_KEY ||
    cfg.SUPABASE_ANON_KEY.includes(
      "YOUR_SUPABASE"
    )
  ) {

    throw new Error(
      "Supabase publishable/anon key is missing."
    );

  }

}


async function initializeSupabase() {

  validateConfig();

  if (
    typeof window.supabase ===
    "undefined"
  ) {

    throw new Error(
      "Supabase library did not load."
    );

  }


  sb =
    window.supabase.createClient(
      cfg.SUPABASE_URL.trim(),
      cfg.SUPABASE_ANON_KEY.trim()
    );


  console.log(
    "CODEBREAKERS: Supabase initialized."
  );

}


/* =========================================================
   AUTH
========================================================= */

async function ensureAuth() {

  const {
    data,
    error
  } =
    await sb.auth.getSession();


  if (error) {
    throw error;
  }


  if (
    data?.session?.user
  ) {

    sessionUser =
      data.session.user;

    return;

  }


  const {
    data: authData,
    error: authError
  } =
    await sb.auth.signInAnonymously();


  if (authError) {

    throw new Error(
      "Anonymous Sign-Ins are not enabled in Supabase."
    );

  }


  if (!authData?.user) {

    throw new Error(
      "Authentication failed."
    );

  }


  sessionUser =
    authData.user;

}


/* =========================================================
   RPC
========================================================= */

async function rpc(
  functionName,
  args = {}
) {

  const {
    data,
    error
  } =
    await sb.rpc(
      functionName,
      args
    );


  if (error) {

    console.error(
      "RPC ERROR:",
      functionName,
      error
    );

    throw new Error(
      error.message ||
      `Error running ${functionName}`
    );

  }


  return data;

}


/* =========================================================
   ROOM LOADING
========================================================= */

async function loadRoom() {

  if (!roomId) {
    return false;
  }


  const {
    data: roomData,
    error: roomError
  } =
    await sb
      .from("rooms")
      .select(
        "id,code,host_user_id,status,state,created_at,updated_at"
      )
      .eq(
        "id",
        roomId
      )
      .maybeSingle();


  if (roomError) {
    throw roomError;
  }


  if (!roomData) {
    return false;
  }


  const {
    data: playerData,
    error: playerError
  } =
    await sb
      .from("players")
      .select(
        "user_id,room_id,name,team,role,joined_at"
      )
      .eq(
        "room_id",
        roomId
      )
      .order(
        "joined_at",
        {
          ascending: true
        }
      );


  if (playerError) {
    throw playerError;
  }


  room =
    roomData;

  players =
    playerData || [];


  me =
    players.find(
      player =>
        player.user_id ===
        sessionUser.id
    ) || null;


  if (!me) {

    clearRoom();

    return false;

  }


  lastServerUpdatedAt =
    room.updated_at || null;


  await updateSecretVisibility();


  subscribeRoom();

  startBackupSync();

  render();


  return true;

}


/* =========================================================
   SECRET KEY
========================================================= */

async function loadSecret() {

  const {
    data,
    error
  } =
    await sb
      .from("room_secrets")
      .select(
        "board_key"
      )
      .eq(
        "room_id",
        roomId
      )
      .maybeSingle();


  if (error) {
    throw error;
  }


  secretKey =
    data?.board_key || null;

}


async function updateSecretVisibility() {

  if (!room || !me) {
    return;
  }


  /*
    Spymasters can see the key during
    an active game.

    Everyone can see it after the game ends.
  */

  const allowed =
    room.status === "finished" ||
    (
      room.status === "playing" &&
      me.role === "spymaster"
    );


  if (!allowed) {

    secretKey = null;

    return;

  }


  try {

    await loadSecret();

  } catch (error) {

    console.error(
      "SECRET KEY ERROR:",
      error
    );

    secretKey = null;

  }

}


/* =========================================================
   PLAYER REFRESH
========================================================= */

async function refreshPlayers() {

  if (
    !roomId ||
    !sessionUser
  ) {
    return;
  }


  const {
    data,
    error
  } =
    await sb
      .from("players")
      .select(
        "user_id,room_id,name,team,role,joined_at"
      )
      .eq(
        "room_id",
        roomId
      )
      .order(
        "joined_at",
        {
          ascending: true
        }
      );


  if (error) {
    throw error;
  }


  players =
    data || [];


  me =
    players.find(
      player =>
        player.user_id ===
        sessionUser.id
    ) || null;


  if (!me) {

    clearRoom();

    show("home");

    return;

  }


  await updateSecretVisibility();

  render();

}


/* =========================================================
   REALTIME
========================================================= */

function subscribeRoom() {

  if (!roomId || !sb) {
    return;
  }


  if (channel) {

    sb.removeChannel(
      channel
    );

  }


  channel =
    sb
      .channel(
        "cb-room-" +
        roomId
      )


      /*
        ROOM CHANGES
      */

      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter:
            "id=eq." +
            roomId
        },
        async () => {

          await syncRoomFromServer(
            true
          );

        }
      )


      /*
        PLAYER / ROLE CHANGES
      */

      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter:
            "room_id=eq." +
            roomId
        },
        async () => {

          try {

            await refreshPlayers();

          } catch (error) {

            console.error(
              "PLAYER REALTIME ERROR:",
              error
            );

          }

        }
      )


      .subscribe(
        status => {

          console.log(
            "Realtime:",
            status
          );

        }
      );

}


/* =========================================================
   SERVER SYNC
========================================================= */

async function syncRoomFromServer(
  force = false
) {

  if (
    !roomId ||
    !sessionUser ||
    !sb ||
    syncInProgress
  ) {
    return;
  }


  syncInProgress =
    true;


  try {

    const {
      data,
      error
    } =
      await sb
        .from("rooms")
        .select(
          "id,code,host_user_id,status,state,created_at,updated_at"
        )
        .eq(
          "id",
          roomId
        )
        .maybeSingle();


    if (error) {
      throw error;
    }


    if (!data) {

      clearRoom();

      show("home");

      return;

    }


    const changed =
      force ||
      !lastServerUpdatedAt ||
      data.updated_at !==
      lastServerUpdatedAt;


    if (!changed) {
      return;
    }


    room =
      data;


    lastServerUpdatedAt =
      data.updated_at;


    await refreshPlayers();


  } catch (error) {

    console.error(
      "SYNC ERROR:",
      error
    );

  } finally {

    syncInProgress =
      false;

  }

}


/* =========================================================
   BACKUP SYNC
========================================================= */

function startBackupSync() {

  stopBackupSync();


  syncTimer =
    setInterval(
      () => {

        if (
          roomId &&
          document.visibilityState !==
          "hidden"
        ) {

          syncRoomFromServer(
            false
          );

        }

      },
      1000
    );

}


function stopBackupSync() {

  if (syncTimer) {

    clearInterval(
      syncTimer
    );

    syncTimer = null;

  }

}


/* =========================================================
   APPLY SERVER STATE
========================================================= */

function applyServerState(
  newState
) {

  if (
    !newState ||
    typeof newState !==
    "object"
  ) {
    return;
  }


  if (!room) {
    return;
  }


  room.state =
    newState;


  if (
    newState.phase ===
    "finished"
  ) {

    room.status =
      "finished";

  } else if (
    newState.phase
  ) {

    room.status =
      "playing";

  }


  render();

}


/* =========================================================
   TIMER
========================================================= */

function formatTimer(
  seconds
) {

  const value =
    Math.max(
      0,
      Math.ceil(seconds)
    );


  const minutes =
    Math.floor(
      value / 60
    );


  const secondsPart =
    value % 60;


  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(secondsPart).padStart(2, "0")
  );

}


function stopGuessTimer() {

  if (guessTimerId) {

    clearInterval(
      guessTimerId
    );

    guessTimerId = null;

  }

}


function updateGuessTimer() {

  const timer =
    $("guessTimer");


  if (!timer) {
    return;
  }


  const deadline =
    room?.state?.guessDeadline
      ? Date.parse(
          room.state.guessDeadline
        )
      : NaN;


  if (!Number.isFinite(deadline)) {

    timer.textContent =
      "01:00";

    timer.classList.remove(
      "danger"
    );

    return;

  }


  const remaining =
    Math.max(
      0,
      (deadline -
        Date.now()) /
        1000
    );


  timer.textContent =
    formatTimer(
      remaining
    );


  timer.classList.toggle(
    "danger",
    remaining <= 10
  );

}


function startGuessTimer() {

  stopGuessTimer();


  const state =
    room?.state || {};


  if (
    state.phase !==
      "guessing" ||
    !state.guessDeadline
  ) {

    return;

  }


  updateGuessTimer();


  guessTimerId =
    setInterval(
      async () => {

        const current =
          room?.state || {};


        if (
          current.phase !==
            "guessing" ||
          !current.guessDeadline
        ) {

          stopGuessTimer();

          return;

        }


        updateGuessTimer();


        const deadline =
          Date.parse(
            current.guessDeadline
          );


        if (
          !Number.isFinite(
            deadline
          ) ||
          Date.now() <
            deadline
        ) {

          return;

        }


        if (
          timerExpiryInFlight
        ) {

          return;

        }


        timerExpiryInFlight =
          true;


        stopGuessTimer();


        try {

          /*
            Server verifies that the
            deadline has really expired.
          */

          const newState =
            await rpc(
              "expire_turn",
              {
                p_room_id:
                  roomId
              }
            );


          applyServerState(
            newState
          );


          await refreshPlayers();


          notify(
            "TIME EXPIRED — turn passed to the other team."
          );


        } catch (error) {

          console.error(
            "TIMER EXPIRY ERROR:",
            error
          );


          await syncRoomFromServer(
            true
          );


        } finally {

          timerExpiryInFlight =
            false;

        }

      },
      250
    );

}


/* =========================================================
   PHASE LABEL
========================================================= */

function phaseLabel() {

  if (!room) {
    return "";
  }


  const phase =
    room.state?.phase;


  if (
    phase ===
    "clue"
  ) {

    return (
      (
        room.state.turn ||
        ""
      ).toUpperCase() +
      " SPYMASTER"
    );

  }


  if (
    phase ===
    "guessing"
  ) {

    return (
      (
        room.state.turn ||
        ""
      ).toUpperCase() +
      " OPERATIVES"
    );

  }


  if (
    phase ===
    "finished"
  ) {

    return "GAME OVER";

  }


  return "LOBBY";

}


/* =========================================================
   MAIN RENDER
========================================================= */

function render() {

  if (!room || !me) {

    show("home");

    return;

  }


  if (
    room.status ===
    "lobby"
  ) {

    renderLobby();

    show("lobby");

  } else {

    renderGame();

    show("game");

  }

}


/* =========================================================
   LOBBY
========================================================= */

function renderLobby() {

  $("roomCodeLabel")
    .textContent =
    room.code;


  $("lobbyStatus")
    .textContent =
    `${players.length}/10 PLAYERS • ${
      players.length < 4
        ? "NEED " +
          (4 - players.length) +
          " MORE"
        : "READY TO START"
    }`;


  $("playerList")
    .innerHTML =
    players.map(
      player => `

        <div class="player">

          <span class="dot"></span>

          <span>
            ${esc(player.name)}
          </span>

          ${
            player.user_id ===
            room.host_user_id

            ? `
              <span class="host">
                HOST
              </span>
            `

            : ""
          }

        </div>

      `
    ).join("");


  const isHost =
    room.host_user_id ===
    sessionUser.id;


  $("startBtn")
    .classList
    .toggle(
      "hidden",
      !isHost
    );


  $("startBtn").disabled =
    !isHost ||
    players.length < 4 ||
    players.length > 10 ||
    actionInFlight;


  $("hostHint")
    .textContent =
    isHost
      ? (
          players.length < 4
            ? "At least 4 players are required."
            : "You are the host. Start when everyone is ready."
        )
      : "Waiting for the host to start the game.";


  $("myIdentity")
    .textContent =
    `${me.name} • ${
      me.team
        ? me.team.toUpperCase()
        : "WAITING"
    }`;

}


/* =========================================================
   GAME RENDER
========================================================= */

function renderGame() {

  const state =
    room.state || {};


  $("roomBadge")
    .textContent =
    room.code;


  $("phaseBadge")
    .textContent =
    phaseLabel();


  $("myBadge")
    .textContent =
    `${me.name} • ${
      (
        me.team ||
        ""
      ).toUpperCase()
    } ${
      (
        me.role ||
        ""
      ).toUpperCase()
    }`;


  $("redCount")
    .textContent =
    state.redRemaining ??
    "-";


  $("blueCount")
    .textContent =
    state.blueRemaining ??
    "-";


  $("redBox")
    .classList
    .toggle(
      "active",
      state.turn === "red" &&
      state.phase !==
        "finished"
    );


  $("blueBox")
    .classList
    .toggle(
      "active",
      state.turn === "blue" &&
      state.phase !==
        "finished"
    );


  const finished =
    state.phase ===
    "finished";


  const spyView =
    me.role ===
      "spymaster" &&
    !!secretKey &&
    !finished;


  renderWin(
    finished,
    state
  );


  renderBoard(
    state,
    finished,
    spyView
  );


  renderControls(
    state,
    finished
  );

  renderNewGameButton();

  renderLog(
    state
  );


  /*
    Keep the timer running after every render.
  */

  if (
    state.phase ===
      "guessing" &&
    state.guessDeadline
  ) {

    if (!guessTimerId) {

      startGuessTimer();

    } else {

      updateGuessTimer();

    }

  } else {

    stopGuessTimer();

  }

}


/* =========================================================
   WIN SCREEN
========================================================= */

function renderWin(
  finished,
  state
) {

  const win =
    $("win");


  if (!finished) {

    win.innerHTML =
      "";

    return;

  }


  win.innerHTML = `

    <div class="win ${
      esc(state.winner || "")
    }">

      ${
        esc(
          (
            state.winner ||
            ""
          ).toUpperCase()
        )
      }

      TEAM WINS

    </div>

    <div class="smallcenter">

      Game ${
        state.gameNumber || 1
      } complete.

      Full board revealed.

    </div>

    ${
      room.host_user_id ===
      sessionUser.id

      ? `

        <button
          class="btn"
          id="nextBtn">

          NEXT GAME

        </button>

      `

      : `

        <div class="smallcenter">

          Waiting for the host
          to start the next game.

        </div>

      `
    }

  `;


  if ($("nextBtn")) {

    $("nextBtn").onclick =
      nextGame;

  }

}


/* =========================================================
   BOARD
========================================================= */

function renderBoard(
  state,
  finished,
  spyView
) {

  const board =
    $("board");


  board.innerHTML =
    "";


  (
    state.words ||
    []
  ).forEach(
    (word, index) => {


      const actuallyRevealed =
        !!state.revealed?.[
          index
        ];


      const visible =
        actuallyRevealed ||
        finished;


      let className =
        "cell";


      /*
        IMPORTANT:

        Operatives use revealedColors.

        Spymasters use secretKey.

        Finished games reveal everything.
      */

      let color =
        null;


      if (
        actuallyRevealed
      ) {

        color =
          state.revealedColors?.[
            index
          ] ||
          secretKey?.[
            index
          ];

      } else if (
        finished
      ) {

        color =
          secretKey?.[
            index
          ];

      } else if (
        spyView
      ) {

        color =
          secretKey?.[
            index
          ];

      }


      if (
        visible &&
        color
      ) {

        className +=
          " revealed " +
          color;


        if (
          color ===
          "assassin"
        ) {

          className +=
            " bomb";

        }

      }

      else if (
        spyView &&
        color
      ) {

        className +=
          " spy-" +
          color;


        if (
          color ===
          "assassin"
        ) {

          className +=
            " bomb";

        }

      }


      /*
        Before clue:
        operative cards remain dim.
      */

      if (
        !spyView &&
        !state.clueWord &&
        !finished
      ) {

        className +=
          " dimmed";

      }


      const button =
        document.createElement(
          "button"
        );


      button.className =
        className;


      button.innerHTML =
        `<span>${esc(word)}</span>`;


      const deadline =
        state.guessDeadline
          ? Date.parse(
              state.guessDeadline
            )
          : NaN;


      const timerExpired =
        Number.isFinite(
          deadline
        ) &&
        Date.now() >=
          deadline;


      const canGuess =
        !actionInFlight &&
        !finished &&
        me.role ===
          "operative" &&
        me.team ===
          state.turn &&
        state.phase ===
          "guessing" &&
        !actuallyRevealed &&
        !timerExpired;


      button.disabled =
        !canGuess;


      if (canGuess) {

        button.onclick =
          () => reveal(index);

      }


      board.appendChild(
        button
      );

    }
  );

}


/* =========================================================
   CONTROLS
========================================================= */

function renderControls(
  state,
  finished
) {

  const controls =
    $("controls");


  controls.innerHTML =
    "";


  /*
    CURRENT SPYMASTER
  */

  if (
    !finished &&
    state.phase ===
      "clue" &&
    me.role ===
      "spymaster" &&
    me.team ===
      state.turn
  ) {

    controls.innerHTML = `

      <div class="panel">

        <div class="eyebrow">
          ${
            state.turn.toUpperCase()
          }
          SPYMASTER
        </div>

        <div class="grid4">

          <input
            id="clueWord"
            placeholder="one word"
            maxlength="20"
          >

          <input
            id="clueNum"
            type="number"
            min="1"
            max="9"
            value="1"
          >

          <input
            id="carry"
            type="number"
            min="0"
            max="24"
            value="0"
          >

          <button
            class="btn"
            id="sendClue"
            ${
              actionInFlight
                ? "disabled"
                : ""
            }
          >

            SEND CLUE

          </button>

        </div>

        <div
          style="
            margin-top:8px;
            color:#71809e;
            font-size:9px;
          "
        >

          Number = guesses this clue.
          Carry = extra guesses from
          previous clue.

        </div>

      </div>

    `;


    $("sendClue").onclick =
      submitClue;


    return;

  }


  /*
    OTHER PLAYERS DURING CLUE PHASE
  */

  if (
    !finished &&
    state.phase ===
      "clue"
  ) {

    controls.innerHTML = `

      <div class="panel waiting">

        <b>
          ${
            esc(
              (
                state.turn ||
                ""
              ).toUpperCase()
            )
          }
          SPYMASTER
        </b>

        <span>
          is preparing the clue…
        </span>

      </div>

    `;


    return;

  }


  /*
    GUESSING PHASE
  */

  if (
    !finished &&
    state.phase ===
      "guessing"
  ) {

    const currentTeam =
      me.role ===
        "operative" &&
      me.team ===
        state.turn;


    const deadline =
      state.guessDeadline
        ? Date.parse(
            state.guessDeadline
          )
        : NaN;


    const seconds =
      Number.isFinite(
        deadline
      )

        ? Math.max(
            0,
            Math.ceil(
              (
                deadline -
                Date.now()
              ) / 1000
            )
          )

        : 60;


    controls.innerHTML = `

      <div
        class="panel"
        style="
          display:flex;
          align-items:center;
          gap:14px;
          flex-wrap:wrap;
        "
      >

        <div
          style="
            flex:1;
            min-width:130px;
          "
        >

          <div class="eyebrow">
            CLUE RECEIVED
          </div>

          <strong
            style="
              font:800 22px Orbitron;
              color:var(--cyan);
              letter-spacing:2px;
            "
          >
            ${esc(
              state.clueWord ||
              ""
            )}
          </strong>

        </div>


        <div
          style="
            text-align:center;
            min-width:80px;
          "
        >

          <div class="eyebrow">
            TIME
          </div>

          <div
            id="guessTimer"
            style="
              font-size:30px;
              font-weight:900;
              line-height:1;
            "
          >
            ${formatTimer(
              seconds
            )}
          </div>

        </div>


        <div
          style="
            text-align:center;
            min-width:100px;
          "
        >

          <div class="eyebrow">
            GUESSES LEFT
          </div>

          <strong
            style="
              font-size:22px;
            "
          >
            ${
              state.guessesLeft ??
              0
            }
          </strong>

        </div>


        <div
          style="
            text-align:center;
            min-width:90px;
          "
        >

          <div class="eyebrow">
            CLUE
          </div>

          <span>
            ${
              state.clueNumber ??
              0
            }
            +
            ${
              state.carryForward ??
              0
            }
          </span>

        </div>


        ${
          currentTeam

          ? `

            <button
              class="btn secondary"
              id="endTurn"
            >

              PASS / END TURN

            </button>

          `

          : ""

        }

      </div>

    `;


    if (
      $("endTurn")
    ) {

      $("endTurn").onclick =
        endTurn;

    }

  }

}

function renderNewGameButton() {

  const button =
    $("newGameBtn");


  if (!button) {
    return;
  }


  /*
    Only the host can see NEW GAME.

    It is intentionally available while
    the game is PLAYING.
  */

  const isHost =
    room &&
    sessionUser &&
    room.host_user_id ===
      sessionUser.id;


  const isPlaying =
    room?.status ===
    "playing";


  button.classList.toggle(
    "hidden",
    !isHost ||
    !isPlaying
  );


  button.disabled =
    actionInFlight;


  if (
    isHost &&
    isPlaying
  ) {

    button.textContent =
      "NEW GAME";

  }

}


/* =========================================================
   EVENT LOG
========================================================= */

function renderLog(
  state
) {

  $("log").innerHTML =
    (
      state.log ||
      []
    )
      .slice(-15)
      .reverse()
      .map(
        item =>
          `<div>${esc(item)}</div>`
      )
      .join("");

}


/* =========================================================
   CREATE ROOM
========================================================= */

async function createRoom() {

  setError(
    "homeErr"
  );


  const name =
    $("homeName")
      .value
      .trim();


  if (!name) {

    setError(
      "homeErr",
      "Enter your player name."
    );

    return;

  }


  try {

    const result =
      await rpc(
        "create_room",
        {
          p_name:
            name
        }
      );


    if (
      !result?.room_id
    ) {

      throw new Error(
        "Room was not created."
      );

    }


    saveRoom(
      result.room_id,
      result.room_code
    );


    await loadRoom();


  } catch (error) {

    console.error(
      "CREATE ROOM ERROR:",
      error
    );


    setError(
      "homeErr",
      getFriendlyError(
        error
      )
    );

  }

}


/* =========================================================
   JOIN ROOM
========================================================= */

async function joinRoom() {

  setError(
    "homeErr"
  );


  const name =
    $("homeName")
      .value
      .trim();


  const code =
    $("joinCode")
      .value
      .trim()
      .toUpperCase();


  if (!name) {

    setError(
      "homeErr",
      "Enter your player name."
    );

    return;

  }


  if (
    code.length !== 5
  ) {

    setError(
      "homeErr",
      "Enter the 5-character room code."
    );

    return;

  }


  try {

    const result =
      await rpc(
        "join_room",
        {
          p_code:
            code,

          p_name:
            name
        }
      );


    saveRoom(
      result.room_id,
      result.room_code
    );


    await loadRoom();


  } catch (error) {

    console.error(
      "JOIN ROOM ERROR:",
      error
    );


    setError(
      "homeErr",
      getFriendlyError(
        error
      )
    );

  }

}


/* =========================================================
   START GAME
========================================================= */

async function startGame() {

  if (
    actionInFlight
  ) {
    return;
  }


  try {

    if (!roomId) {

      throw new Error(
        "No active room."
      );

    }


    if (
      room.host_user_id !==
      sessionUser.id
    ) {

      throw new Error(
        "Only the host can start the game."
      );

    }


    if (
      players.length < 4
    ) {

      throw new Error(
        "At least 4 players are required."
      );

    }


    if (
      players.length > 10
    ) {

      throw new Error(
        "Maximum 10 players are allowed."
      );

    }


    actionInFlight =
      true;


    const button =
      $("startBtn");


    if (button) {

      button.disabled =
        true;

      button.textContent =
        "STARTING...";

    }


    const newState =
      await rpc(
        "start_room",
        {
          p_room_id:
            roomId
        }
      );


    applyServerState(
      newState
    );


    await refreshPlayers();


  } catch (error) {

    console.error(
      "START ERROR:",
      error
    );


    notify(
      getFriendlyError(
        error
      )
    );


    await syncRoomFromServer(
      true
    );


  } finally {

    actionInFlight =
      false;


    const button =
      $("startBtn");


    if (button) {

      button.textContent =
        "ASSIGN TEAMS & START";

      button.disabled =
        false;

    }


    render();

  }

}


/* =========================================================
   SUBMIT CLUE
========================================================= */

async function submitClue() {

  if (
    actionInFlight
  ) {
    return;
  }


  const word =
    $("clueWord")
      ?.value
      .trim() ||
    "";


  const number =
    Number(
      $("clueNum")
        ?.value
    );


  const carry =
    Number(
      $("carry")
        ?.value ||
      0
    );


  if (!word) {

    notify(
      "Enter a clue word."
    );

    return;

  }


  if (
    /\s/.test(word)
  ) {

    notify(
      "Clue must be exactly one word."
    );

    return;

  }


  if (
    !Number.isInteger(
      number
    ) ||
    number < 1 ||
    number > 9
  ) {

    notify(
      "Clue number must be 1-9."
    );

    return;

  }


  if (
    !Number.isInteger(
      carry
    ) ||
    carry < 0 ||
    carry > 24
  ) {

    notify(
      "Carry-forward must be 0-24."
    );

    return;

  }


  try {

    actionInFlight =
      true;


    const newState =
      await rpc(
        "submit_clue",
        {
          p_room_id:
            roomId,

          p_word:
            word,

          p_number:
            number,

          p_carry:
            carry
        }
      );


    /*
      Server starts the timer here.
    */

    applyServerState(
      newState
    );


  } catch (error) {

    console.error(
      "CLUE ERROR:",
      error
    );


    notify(
      getFriendlyError(
        error
      )
    );


    await syncRoomFromServer(
      true
    );


  } finally {

    actionInFlight =
      false;

    render();

  }

}


/* =========================================================
   REVEAL CARD
========================================================= */

async function reveal(
  index
) {

  if (
    actionInFlight
  ) {
    return;
  }


  const state =
    room?.state ||
    {};


  /*
    Local timer check.
  */

  if (
    state.guessDeadline
  ) {

    const deadline =
      Date.parse(
        state.guessDeadline
      );


    if (
      Number.isFinite(
        deadline
      ) &&
      Date.now() >=
        deadline
    ) {

      try {

        const newState =
          await rpc(
            "expire_turn",
            {
              p_room_id:
                roomId
            }
          );


        applyServerState(
          newState
        );


      } catch (error) {

        await syncRoomFromServer(
          true
        );

      }


      notify(
        "TIME EXPIRED — turn passed to the other team."
      );


      return;

    }

  }


  /*
    Client-side permission check.

    Server remains authoritative.
  */

  if (
    me.role !==
      "operative" ||

    me.team !==
      state.turn ||

    state.phase !==
      "guessing" ||

    state.revealed?.[
      index
    ]
  ) {

    await syncRoomFromServer(
      true
    );


    notify(
      "Game state was updated. Please try again."
    );


    return;

  }


  try {

    actionInFlight =
      true;


    const newState =
      await rpc(
        "reveal_card",
        {
          p_room_id:
            roomId,

          p_index:
            index
        }
      );


    /*
      Apply returned server state
      immediately.
    */

    applyServerState(
      newState
    );


    /*
      If game finished, roles may have
      changed in the database.
    */

    if (
      newState?.phase ===
      "finished"
    ) {

      await refreshPlayers();

    }


  } catch (error) {

    console.error(
      "REVEAL ERROR:",
      error
    );


    await syncRoomFromServer(
      true
    );


    notify(
      getFriendlyError(
        error
      )
    );


  } finally {

    actionInFlight =
      false;

    render();

  }

}


/* =========================================================
   END TURN
========================================================= */

async function endTurn() {

  if (
    actionInFlight
  ) {
    return;
  }


  try {

    actionInFlight =
      true;


    const newState =
      await rpc(
        "end_turn",
        {
          p_room_id:
            roomId
        }
      );


    applyServerState(
      newState
    );


  } catch (error) {

    console.error(
      "END TURN ERROR:",
      error
    );


    notify(
      getFriendlyError(
        error
      )
    );


    await syncRoomFromServer(
      true
    );


  } finally {

    actionInFlight =
      false;

    render();

  }

}


/* =========================================================
   NEXT GAME
========================================================= */

async function nextGame() {

  if (
    actionInFlight
  ) {
    return;
  }


  if (
    room.host_user_id !==
    sessionUser.id
  ) {

    notify(
      "Only the host can start the next game."
    );

    return;

  }


  try {

    actionInFlight =
      true;


    const newState =
      await rpc(
        "next_game",
        {
          p_room_id:
            roomId
        }
      );


    applyServerState(
      newState
    );


    /*
      IMPORTANT:

      next_game changes player roles,
      so refresh the player table.
    */

    await refreshPlayers();


    notify(
      `Game ${
        newState.gameNumber ||
        2
      } started! Roles rotated.`
    );


  } catch (error) {

    console.error(
      "NEXT GAME ERROR:",
      error
    );


    notify(
      getFriendlyError(
        error
      )
    );


    await syncRoomFromServer(
      true
    );


  } finally {

    actionInFlight =
      false;

    render();

  }

}


/* =========================================================
   COPY ROOM CODE
========================================================= */

async function copyRoomCode() {

  const code =
    room?.code ||
    roomCode;


  if (!code) {

    notify(
      "Room code is not available."
    );

    return;

  }


  /*
    Modern Clipboard API.
  */

  try {

    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {

      await navigator.clipboard.writeText(
        code
      );


      notify(
        "Room code copied!"
      );


      return;

    }

  } catch (error) {

    console.warn(
      "Clipboard API failed:",
      error
    );

  }


  /*
    Fallback for normal HTTP hosting.
  */

  try {

    const textarea =
      document.createElement(
        "textarea"
      );


    textarea.value =
      code;


    textarea.style.position =
      "fixed";

    textarea.style.left =
      "-9999px";


    document.body.appendChild(
      textarea
    );


    textarea.focus();
    textarea.select();


    const copied =
      document.execCommand(
        "copy"
      );


    textarea.remove();


    if (copied) {

      notify(
        "Room code copied!"
      );

    } else {

      notify(
        "Room code: " +
        code
      );

    }

  } catch (error) {

    console.error(
      "COPY ERROR:",
      error
    );


    notify(
      "Room code: " +
      code
    );

  }

}


/* =========================================================
   LEAVE ROOM
========================================================= */

async function leave() {

  if (!roomId) {

    clearRoom();

    show("home");

    return;

  }


  try {

    await rpc(
      "leave_room",
      {
        p_room_id:
          roomId
      }
    );


  } catch (error) {

    console.error(
      "LEAVE ERROR:",
      error
    );

  } finally {

    clearRoom();

    show("home");

  }

}

async function restartGame() {

  if (
    actionInFlight
  ) {
    return;
  }


  if (
    !room ||
    !sessionUser
  ) {
    return;
  }


  if (
    room.host_user_id !==
    sessionUser.id
  ) {

    notify(
      "Only the host can start a new game."
    );

    return;

  }


  if (
    room.status !==
    "playing"
  ) {

    notify(
      "There is no active game."
    );

    return;

  }


  /*
    Confirmation prevents accidental
    restart during an important game.
  */

  const confirmed =
    confirm(
      "Start a new game?\n\n" +
      "The current game will be abandoned " +
      "and a new board will be created.\n\n" +
      "The same players will remain and " +
      "roles will rotate."
    );


  if (!confirmed) {
    return;
  }


  try {

    actionInFlight =
      true;


    const button =
      $("newGameBtn");


    if (button) {

      button.disabled =
        true;

      button.textContent =
        "STARTING...";

    }


    /*
      Server creates the new board,
      rotates roles and starts the game.
    */

    const newState =
      await rpc(
        "restart_game",
        {
          p_room_id:
            roomId
        }
      );


    /*
      Apply the new state immediately.
    */

    applyServerState(
      newState
    );


    /*
      IMPORTANT:
      restart_game changes roles,
      therefore reload players.
    */

    await refreshPlayers();


    notify(
      `Game ${
        newState.gameNumber ||
        "new"
      } started!`
    );


  } catch (error) {

    console.error(
      "NEW GAME ERROR:",
      error
    );


    notify(
      getFriendlyError(
        error
      )
    );


    /*
      Make sure every phone returns
      to the actual server state.
    */

    await syncRoomFromServer(
      true
    );


  } finally {

    actionInFlight =
      false;


    render();

  }

}


/* =========================================================
   FRIENDLY ERRORS
========================================================= */

function getFriendlyError(
  error
) {

  if (!error) {
    return "Unknown error.";
  }


  const message =
    error.message ||
    String(error);


  if (
    message.includes(
      "Failed to fetch"
    )
  ) {

    return (
      "Cannot connect to Supabase."
    );

  }


  if (
    message.toLowerCase()
      .includes(
        "anonymous"
      )
  ) {

    return (
      "Enable Anonymous Sign-Ins in Supabase."
    );

  }


  if (
    message.includes(
      "Invalid API"
    ) ||
    message.includes(
      "JWT"
    )
  ) {

    return (
      "Supabase API key is invalid."
    );

  }


  return message;

}


/* =========================================================
   BUTTON EVENTS
========================================================= */

$("createBtn").onclick =
  createRoom;


$("joinBtn").onclick =
  joinRoom;


$("startBtn").onclick =
  startGame;


$("leaveBtn").onclick =
  leave;

$("newGameBtn").onclick =
  restartGame;


/*
  COPY ROOM CODE

  This matches the updated HTML:
  
  id="copyRoomBtn"
*/

const copyButton =
  $("copyRoomBtn");


if (copyButton) {

  copyButton.onclick =
    copyRoomCode;

}


/*
  Room code formatting.
*/

$("joinCode")
  .addEventListener(
    "input",
    event => {

      event.target.value =
        event.target.value
          .toUpperCase()
          .replace(
            /[^A-Z0-9]/g,
            ""
          )
          .slice(
            0,
            5
          );

    }
  );


/* =========================================================
   VISIBILITY / RECONNECT
========================================================= */

document.addEventListener(
  "visibilitychange",
  async () => {

    if (
      document.visibilityState ===
      "visible"
    ) {

      await syncRoomFromServer(
        true
      );

    }

  }
);


/* =========================================================
   BOOT
========================================================= */

async function boot() {

  try {

    console.log(
      "CODEBREAKERS starting..."
    );


    await initializeSupabase();


    await ensureAuth();


    /*
      Reconnect to the previous room
      if this browser still belongs to it.
    */

    if (
      roomId &&
      await loadRoom()
    ) {

      console.log(
        "Reconnected:",
        roomCode
      );


      return;

    }


    /*
      Saved room no longer exists
      or player was removed.
    */

    if (roomId) {

      clearRoom();

    }


    show(
      "home"
    );


    console.log(
      "CODEBREAKERS ready."
    );


  } catch (error) {

    console.error(
      "BOOT ERROR:",
      error
    );


    show(
      "home"
    );


    setError(
      "homeErr",
      getFriendlyError(
        error
      )
    );

  }

}


boot();
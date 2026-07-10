type LobbyMode = 'solo' | 'host' | 'join' | 'rooms';
type SurvivorLook = 'mustard' | 'moss' | 'rust' | 'flood';

const MODES: ReadonlyArray<{ id: LobbyMode; label: string }> = [
  { id: 'solo', label: 'SOLO' },
  { id: 'host', label: 'HOST' },
  { id: 'join', label: 'JOIN' },
  { id: 'rooms', label: 'ROOMS' },
];

const LOOKS: ReadonlyArray<{ id: SurvivorLook; label: string }> = [
  { id: 'mustard', label: 'MUSTARD' },
  { id: 'moss', label: 'MOSS' },
  { id: 'rust', label: 'RUST' },
  { id: 'flood', label: 'FLOOD' },
];

export function CoopLobby() {
  return (
    <div id="coop-lobby" aria-label="Game mode">
      <div className="coop-mode-tabs" role="group" aria-label="Select game mode">
        {MODES.map(({ id, label }) => (
          <button
            className={id === 'solo' ? 'is-selected' : undefined}
            id={`mode-${id}`}
            key={id}
            type="button"
            aria-pressed={id === 'solo'}
          >
            {label}
          </button>
        ))}
      </div>

      <div id="coop-form" hidden>
        <label htmlFor="player-name">
          <span>CALLSIGN</span>
          <input
            id="player-name"
            name="player-name"
            type="text"
            maxLength={18}
            autoComplete="nickname"
            spellCheck={false}
          />
        </label>
        <label id="room-code-field" htmlFor="room-code" hidden>
          <span>ROOM CODE</span>
          <input
            id="room-code"
            name="room-code"
            type="text"
            maxLength={8}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
          />
        </label>
        <button id="room-visibility" type="button" aria-pressed="true" hidden>PUBLIC</button>
        <button id="coop-connect" type="button">OPEN ROOM</button>
      </div>

      <section id="room-directory" aria-labelledby="room-directory-title" hidden>
        <div className="room-directory-head">
          <span id="room-directory-title">OPEN SIGNALS</span>
          <span id="room-directory-count">--</span>
        </div>
        <div id="room-list" role="list" aria-label="Public multiplayer rooms" />
        <p id="room-directory-empty">SCANNING OPEN SIGNALS</p>
      </section>

      <section id="waiting-room" aria-labelledby="waiting-room-title" hidden>
        <div className="waiting-room-head">
          <span id="waiting-room-title">ASSEMBLY ROOM</span>
          <strong id="waiting-room-count">1/4</strong>
        </div>
        <div id="waiting-stage">
          <div id="waiting-slots" role="list" aria-label="Players in waiting room" />
        </div>
        <div id="look-picker" role="group" aria-label="Choose survivor suit">
          <span>CHOOSE SUIT</span>
          <div>
            {LOOKS.map(({ id, label }) => (
              <button key={id} type="button" data-look={id} aria-pressed={id === 'mustard'}>
                <i />
                <b>{label}</b>
              </button>
            ))}
          </div>
        </div>
        <p id="waiting-room-status">CHOOSE A SUIT / READY WHEN THE TEAM IS ASSEMBLED</p>
      </section>

      <div id="coop-feedback" role="status" aria-live="polite">
        <span id="coop-state">SOLO RECORDING</span>
        <button id="copy-invite" type="button" hidden>SHARE INVITE</button>
      </div>
    </div>
  );
}

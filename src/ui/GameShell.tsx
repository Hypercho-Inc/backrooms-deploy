import { CoopLobby } from './CoopLobby';

function Hud() {
  return (
    <>
      <header id="hud">
        <div className="hud-mark">
          <span id="level-label">LEVEL 0</span>
          <small id="status">SIGNAL LOST</small>
        </div>
        <div id="objective" role="status" aria-live="polite">FIND A WAY OUT</div>
        <div id="coop-hud" aria-label="Co-op room status">
          <span id="coop-room">ROOM ----</span>
          <small id="coop-roster">1 SURVIVOR</small>
          <div id="voice-controls" role="group" aria-label="Room voice chat" hidden>
            <button id="voice-toggle" type="button" aria-pressed="false">VOICE OFF</button>
            <button id="mic-toggle" type="button" aria-pressed="false" hidden>MIC LIVE</button>
            <span id="voice-state" className="visually-hidden" role="status" aria-live="polite">
              Voice chat off
            </span>
          </div>
        </div>
        <button id="sound-toggle" type="button" aria-label="Mute sound">SOUND ON</button>
      </header>

      <div id="crosshair" aria-hidden="true"><span /><span /></div>
      <div id="interact" role="status">E&nbsp;&nbsp;OPEN</div>
      <div id="message" role="status" />
      <div id="stamina" aria-label="Stamina"><span /></div>

      <div id="survival-hud" aria-label="Survival equipment">
        <div id="flashlight-hud">
          <b id="flashlight-label">F&nbsp;&nbsp;LIGHT ON</b>
          <span aria-hidden="true"><i /></span>
        </div>
        <small id="evidence-state">ARCHIVE 0/3</small>
        <em id="stealth-state" hidden>UNSEEN / HOLD STILL</em>
      </div>
    </>
  );
}

function TouchControls() {
  return (
    <div id="touch-ui" role="group" aria-label="Touch controls">
      <div id="move-pad"><div id="move-stick" /></div>
      <div id="touch-look" />
      <button id="touch-sprint" type="button">RUN</button>
      <button id="touch-crouch" type="button" aria-pressed="false">CROUCH</button>
      <button id="touch-light" type="button">LIGHT</button>
      <button id="touch-flash" type="button">FLASH</button>
      <button id="touch-action" type="button">OPEN</button>
    </div>
  );
}

function Overlay() {
  return (
    <section id="overlay" className="is-visible" data-mode="start" aria-labelledby="overlay-title">
      <div className="overlay-noise" aria-hidden="true" />
      <div className="overlay-frame">
        <div id="classification" className="classification">THRESHOLD ARCHIVE / LEVEL 0</div>
        <div className="overlay-copy">
          <p id="overlay-kicker">UNVERIFIED FOOTAGE</p>
          <h1 id="overlay-title">YOU WERE<br />NEVER HERE.</h1>
          <p id="overlay-body">The carpet is damp. The lights know where you are.</p>
        </div>
        <div className="overlay-actions">
          <CoopLobby />
          <button id="enter-button" type="button">
            <span id="enter-label">ENTER LEVEL 0</span>
            <i aria-hidden="true">↳</i>
          </button>
          <div id="controls-copy">
            <span><b>WASD</b> MOVE</span>
            <span><b>MOUSE</b> LOOK</span>
            <span><b>SHIFT</b> RUN</span>
            <span><b>C</b> CROUCH / HIDE</span>
            <span><b>E</b> OPEN</span>
            <span><b>F</b> LIGHT</span>
            <span><b>Q</b> FLASH</span>
          </div>
          <p className="survival-brief">
            LIGHT REVEALS YOU. GO DARK AND HOLD STILL TO HIDE. HOLD E TO REPAIR; ARCHIVES RESTORE
            CHARGE; FLASHES ARE LOUD.
          </p>
        </div>
        <p className="headphones">HEADPHONES RECOMMENDED / CONTAINS FLASHING LIGHTS</p>
      </div>
    </section>
  );
}

export function GameShell() {
  return (
    <main id="game" className="relative min-h-dvh w-full overflow-hidden" aria-label="THRESHOLD first-person horror game">
      <div id="viewport" aria-hidden="true" />
      <div id="vignette" aria-hidden="true" />
      <canvas id="grain" aria-hidden="true" />
      <div id="threat" aria-hidden="true" />

      <Hud />
      <TouchControls />
      <Overlay />

      <section id="unsupported" aria-live="assertive">
        <p>WEBGL 2 REQUIRED</p>
        <h1>This level cannot render here.</h1>
        <span>Try a current desktop browser with hardware acceleration enabled.</span>
      </section>
    </main>
  );
}

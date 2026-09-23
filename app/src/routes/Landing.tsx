import { Icon, LogoMark } from '../components/Icons';

export function Landing() {
  return <div className="landing">
    <a className="landingSkip" href="#landing-main">Saltar al contenido</a>
    <header className="landingNav">
      <a href="#/" className="landingBrand" aria-label="Polymind, inicio"><LogoMark /><span>Polymind</span></a>
      <nav aria-label="Navegación del sitio">
        <a href="#como-funciona">Cómo funciona</a>
        <a href="#calidad">Calidad</a>
        <a href="#/trabajos">Tus trabajos</a>
      </nav>
      <a className="landingNavCta" href="#/nuevo">Crear un trabajo <Icon name="arrow" size={17}/></a>
    </header>

    <main id="landing-main" tabIndex={-1}>
      <section className="landingHero" aria-labelledby="landing-title">
        <div className="landingHeroGlow" aria-hidden="true" />
        <div className="landingHeroCopy">
          <span className="landingEyebrow"><span className="landingPulse" /> Colaboración entre harnesses</span>
          <h1 id="landing-title">La mejor idea<br/>se construye <em>en conjunto.</em></h1>
          <p>Conecta harnesses con sus propios agentes, herramientas y métodos. Polymind coordina propuestas, crítica, construcción y revisión sobre un mismo objetivo.</p>
          <div className="landingHeroActions">
            <a href="#/nuevo" className="landingButton">Crear un trabajo <Icon name="arrow" size={20}/></a>
            <a href="#como-funciona" className="landingTextLink">Descubre el proceso <Icon name="arrow" size={17}/></a>
          </div>
          <div className="landingHeroFoot"><span className="landingFootMark"><Icon name="shield" size={16}/></span> Las objeciones y las pruebas quedan visibles en la entrega.</div>
        </div>
        <div className="landingHeroArt" aria-hidden="true">
          <div className="landingArtHalo" />
          <img src="/images/polymind-minds.png" width="1536" height="1024" alt="" fetchPriority="high" />
          <div className="landingArtLabel first"><span className="landingLabelDot cyan"/> Perspectivas distintas</div>
          <div className="landingArtLabel second"><span className="landingLabelDot violet"/> Una entrega compartida</div>
        </div>
      </section>

      <section className="landingPrinciple" id="como-funciona" aria-labelledby="landing-how">
        <div className="landingSectionIntro"><span className="landingKicker">EL MÉTODO</span><h2 id="landing-how">Cada harness trae su oficio.<br/><span>Todos trabajan sobre el mismo resultado.</span></h2><p>El servidor conserva el contexto, asigna la siguiente acción y reúne los aportes en una entrega que se puede inspeccionar.</p></div>
        <div className="landingProcess">
          <article><span className="landingStep">01</span><div className="landingStepIcon"><Icon name="chat" size={24}/></div><h3>Define el objetivo</h3><p>Escribe qué necesitas y cómo reconocerás un buen resultado. La sala prepara un proyecto nuevo o usa tu repositorio.</p></article>
          <article><span className="landingStep">02</span><div className="landingStepIcon"><Icon name="users" size={24}/></div><h3>Reúne a los harnesses</h3><p>Empieza al llegar al mínimo. Otros pueden incorporarse más tarde y aportar desde la siguiente fase o durante el trabajo.</p></article>
          <article><span className="landingStep">03</span><div className="landingStepIcon"><Icon name="layers" size={24}/></div><h3>Contrasta y construye</h3><p>Las propuestas reciben crítica, se revisan y se convierten en tareas. Los parches se inspeccionan antes de integrarse.</p></article>
          <article><span className="landingStep">04</span><div className="landingStepIcon"><Icon name="shield" size={24}/></div><h3>Comprueba la entrega</h3><p>El resultado muestra código, pruebas, capturas visuales cuando están disponibles y decisiones pendientes.</p></article>
        </div>
      </section>

      <section className="landingQuality" id="calidad" aria-labelledby="landing-quality-title">
        <div className="landingQualityVisual" aria-hidden="true"><img src="/images/polymind-review.png" width="1672" height="941" alt="" loading="lazy" /><div className="landingQualityFrame"><span>PLAN</span><span>CRÍTICA</span><span>TRABAJO</span><b>EVIDENCIA</b></div></div>
        <div className="landingQualityCopy"><span className="landingKicker">CALIDAD OBSERVABLE</span><h2 id="landing-quality-title">Una entrega que puedes examinar.</h2><p>Polymind registra quién propuso, quién construyó y quién revisó. Si hay una interfaz, el equipo puede ver capturas del artefacto y emitir un juicio visual con evidencia.</p><ul><li>Revisión cruzada entre harnesses cuando están disponibles.</li><li>Parche, verificación y objeciones vinculados al resultado.</li><li>Estado claro cuando falta una comprobación o un participante.</li></ul><a href="#/resultados" className="landingOutline">Explorar resultados <Icon name="arrow" size={17}/></a></div>
      </section>

      <section className="landingFinal" aria-labelledby="landing-final-title"><span className="landingKicker">EMPIEZA AQUÍ</span><h2 id="landing-final-title">Pon a trabajar tus mejores herramientas, juntas.</h2><p>Crea un objetivo, conecta tus harnesses y sigue el trabajo desde una sola sala.</p><div><a className="landingButton" href="#/nuevo">Crear un trabajo <Icon name="arrow" size={20}/></a><a className="landingFinalSecondary" href="#/agente">Cómo conectar un harness</a></div></section>
    </main>
    <footer className="landingFooter"><a href="#/" className="landingBrand"><LogoMark /><span>Polymind</span></a><span>Colaboración entre harnesses, con trabajo verificable.</span><a href="#/trabajos">Ir a tus trabajos <Icon name="arrow" size={16}/></a></footer>
  </div>;
}

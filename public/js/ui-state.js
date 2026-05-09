// public/js/ui-state.js

/**
 * UI State Machine
 * Controla qué vista se muestra (Rojo, Amarillo, Verde, etc)
 */
export class UIState {
  constructor() {
    this.currentState = 'disconnected'; // disconnected, loading, syncing, ready, playing
    this.elements = {};
  }

  registerElement(stateName, domId) {
    const el = document.getElementById(domId);
    if (!el) console.warn(`Elemento no encontrado: ${domId}`);
    this.elements[stateName] = el;
  }

  transitionTo(newState) {
    if (this.currentState === newState) return;
    
    console.log(`[UI] Transition: ${this.currentState} -> ${newState}`);
    
    // Ocultar todos
    Object.values(this.elements).forEach(el => {
      if (el) el.classList.remove('active');
    });

    // Mostrar el nuevo
    if (this.elements[newState]) {
      this.elements[newState].classList.add('active');
    }

    // Cambiar color del body para dar feedback visual fuerte
    document.body.className = `state-${newState}`;
    
    this.currentState = newState;
    
    // Hack global para que syncEngine lo reporte al backend
    window.uiState = this;
  }

  getCurrent() {
    return this.currentState;
  }
}

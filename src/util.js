const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const lista = (texto) => (texto || "").split(",").map((s) => s.trim()).filter(Boolean);

module.exports = { normalizar, esperar, lista };

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  /**
   * better-sqlite3 ist ein natives Modul (.node-Binary). Ohne diesen Eintrag
   * versucht Turbopack, es mitzubündeln, und scheitert.
   *
   * @google/genai bringt eigene Node-Abhängigkeiten mit und gehört aus
   * demselben Grund hierher.
   */
  serverExternalPackages: ["better-sqlite3", "@google/genai"],

  /**
   * Der Code unter ../src liegt außerhalb von web/. Damit Turbopack die
   * Projektwurzel richtig setzt und nicht über die zweite package.json
   * stolpert.
   */
  turbopack: {
    root: "..",
  },
}

export default nextConfig

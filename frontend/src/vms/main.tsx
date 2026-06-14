import React from "react";
import { createRoot } from "react-dom/client";
import { VmsApp } from "./VmsApp";
import "./styles.css";

const root = document.querySelector("#root");
if (!root) {
  throw new Error("VMS root element is missing.");
}

createRoot(root).render(
  <VmsApp />,
);

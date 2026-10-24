import { app } from "electron";
import fs from "node:fs";

fs.writeFileSync("C:\\Users\\Administrator\\dhs\\downloadx\\test\\simple_probe.txt", "Electron started successfully!\n");
console.log("ELECTRON STARTED");
app.whenReady().then(() => {
  fs.appendFileSync("C:\\Users\\Administrator\\dhs\\downloadx\\test\\simple_probe.txt", "App is ready!\n");
  console.log("APP READY");
  app.quit();
});

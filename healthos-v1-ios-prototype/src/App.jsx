import { useState } from "react";
import todayScreen from "./assets/today-screen-reference.png";
import coachScreen from "./assets/coach-screen-reference.png";
import mapScreen from "./assets/map-screen-reference.png";
import reviewScreen from "./assets/review-screen-reference.png";

const tabs = [
  { id: "today", label: "Today", zh: "今日", image: todayScreen },
  { id: "coach", label: "Coach", zh: "教练", image: coachScreen },
  { id: "map", label: "Map", zh: "地图", image: mapScreen },
  { id: "review", label: "Review", zh: "回顾", image: reviewScreen },
];

function NavHotspots({ activeTab, onChange }) {
  return (
    <nav className="nav-hotspots" aria-label="主菜单">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="nav-hotspot"
          aria-label={`${tab.label} ${tab.zh}`}
          aria-current={activeTab === tab.id ? "page" : undefined}
          onClick={() => onChange(tab.id)}
        />
      ))}
    </nav>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState("today");
  const activeScreen = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <main className="stage">
      <div className="phone-shell">
        <img
          className="screen-reference"
          src={activeScreen.image}
          alt={`HealthOS V1.0 ${activeScreen.label} 高保真界面`}
          draggable="false"
        />
        <NavHotspots activeTab={activeTab} onChange={setActiveTab} />
      </div>
    </main>
  );
}

import { describe, expect, test } from "vitest";

import { buildToolsInvokeUrl, classifyGatewayHttpStatus } from "../src/gateway_detector.js";

describe("gateway_detector helpers", () => {
  test("buildToolsInvokeUrl appends tools invoke path", () => {
    expect(buildToolsInvokeUrl("http://127.0.0.1:3456").toString()).toBe(
      "http://127.0.0.1:3456/tools/invoke"
    );
  });

  test("buildToolsInvokeUrl auto-adds http scheme", () => {
    expect(buildToolsInvokeUrl("127.0.0.1:3456").toString()).toBe("http://127.0.0.1:3456/tools/invoke");
  });

  test("classifies HTTP statuses into gateway states", () => {
    expect(classifyGatewayHttpStatus(200)).toBe("online");
    expect(classifyGatewayHttpStatus(401)).toBe("unauthorized");
    expect(classifyGatewayHttpStatus(503)).toBe("offline");
    expect(classifyGatewayHttpStatus(404)).toBe("error");
  });
});


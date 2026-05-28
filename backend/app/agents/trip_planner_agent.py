"""多智能体旅行规划系统"""

import json
import asyncio
from typing import Dict, Any, List
from hello_agents import SimpleAgent
# from hello_agents.tools import MCPTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from ..services.llm_service import get_llm
from ..models.schemas import TripRequest, TripPlan, DayPlan, Attraction, Meal, WeatherInfo, Location, Hotel
from ..config import get_settings

# ============ Agent提示词 ============

ATTRACTION_AGENT_PROMPT = """你是景点搜索专家。你的任务是根据城市和用户偏好搜索合适的景点。

**重要提示:**
你必须使用工具来搜索景点!不要自己编造景点信息!

**工具调用格式:**
使用maps_text_search工具时,必须严格按照以下格式:
`[TOOL_CALL:maps_text_search:keywords=景点关键词,city=城市名]`

**示例:**
用户: "搜索北京的历史文化景点"
你的回复: [TOOL_CALL:maps_text_search:keywords=历史文化,city=北京]

用户: "搜索上海的公园"
你的回复: [TOOL_CALL:maps_text_search:keywords=公园,city=上海]

**注意:**
1. 必须使用工具,不要直接回答
2. 格式必须完全正确,包括方括号和冒号
3. 参数用逗号分隔
"""

WEATHER_AGENT_PROMPT = """你是天气查询专家。你的任务是查询指定城市的天气信息。

**重要提示:**
你必须使用工具来查询天气!不要自己编造天气信息!

**工具调用格式:**
使用maps_weather工具时,必须严格按照以下格式:
`[TOOL_CALL:maps_weather:city=城市名]`

**示例:**
用户: "查询北京天气"
你的回复: [TOOL_CALL:maps_weather:city=北京]

用户: "上海的天气怎么样"
你的回复: [TOOL_CALL:maps_weather:city=上海]

**注意:**
1. 必须使用工具,不要直接回答
2. 格式必须完全正确,包括方括号和冒号
"""

HOTEL_AGENT_PROMPT = """你是酒店推荐专家。你的任务是根据城市、景点位置以及天气情况，推荐最合适的酒店。

【🚨 核心干预依据】
1. 景点分布：请分析上游提供的景点坐标簇，选择几何中心或核心景点周边（Around Search）进行搜索。
2. 天气状况：如果天气信息指示有连续大雨、暴雪等恶劣天气，请优先推荐【离地铁站近、或者自带高品质餐厅/室内娱乐设施】的综合性酒店，并在回复中说明理由。

**工具调用格式:**
必须严格按照以下格式（包含坐标锚点与半径）：
`[TOOL_CALL:amap_maps_text_search:keywords=酒店,city=城市名,location=经度,纬度,radius=5000]`


**注意:**
1. 必须使用工具,不要直接回答
2. 格式必须完全正确,包括方括号和冒号
3. 关键词使用"酒店"或"宾馆"
"""

REVIEWER_AGENT_PROMPT = """你是旅行行程审查专家。你的任务是严格审查由行程规划专家生成的旅行计划。

请对照“原始用户请求”、“天气信息”和“生成的行程计划”，评估以下几个维度：
1. 【天气舒适度】：如果某一天是雨天、雪天、恶劣天气，审查是否给用户安排了大量的户外景区（如爬山、公园、露天广场）。如果是，必须指出哪一天不合理。
2. 【地理合理性】：审查每天安排的景点之间、以及景点与当天酒店之间是否跨度过大（例如同城跨度超过 30 公里）。
3. 【预算契合度】：审查总体预算是否超出了用户的限制。

如果检查出不合理的地方，请详细、不留情面地指出具体是哪一天、哪个地方做的不好，并给出明确的修改建议。

你的输出格式必须严格为以下两部分之一：

如果审查【不通过】，请回复：
[STATUS: REJECTED]
原因与修改建议：
1. ...
2. ...

如果审查【通过】，请回复：
[STATUS: PASSED]
"""


PLANNER_AGENT_PROMPT = """你是行程规划专家。你的任务是结合并发获取的景点、天气和酒店信息，生成详细的旅行计划。

【🚨 天气自适应干预要求】
请仔细比对每一天的具体天气预测(weather_info):
1. 如果某一天是【雨天/雪天/大风】,你必须展现智能体的思考决策能力——在这一天的行程(attractions)中,【严禁或尽量减少】安排露天户外景点（如公园、山岳、广场），转而将基础景点数据中的【室内景点】（如博物馆、展馆、商圈）调度到这一天。
2. 如果全是晴天，则按照地理距离就近合理编排。

请严格按照以下JSON格式返回旅行计划:

请严格按照以下JSON格式返回旅行计划:
```json
{
  "city": "城市名称",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "day_index": 0,
      "description": "第1天行程概述",
      "transportation": "交通方式",
      "accommodation": "住宿类型",
      "hotel": {
        "name": "酒店名称",
        "address": "酒店地址",
        "location": {"longitude": 116.397128, "latitude": 39.916527},
        "price_range": "300-500元",
        "rating": "4.5",
        "distance": "距离景点2公里",
        "type": "经济型酒店",
        "estimated_cost": 400
      },
      "attractions": [
        {
          "name": "景点名称",
          "address": "详细地址",
          "location": {"longitude": 116.397128, "latitude": 39.916527},
          "visit_duration": 120,
          "description": "景点详细描述",
          "category": "景点类别",
          "ticket_price": 60
        }
      ],
      "meals": [
        {"type": "breakfast", "name": "早餐推荐", "description": "早餐描述", "estimated_cost": 30},
        {"type": "lunch", "name": "午餐推荐", "description": "午餐描述", "estimated_cost": 50},
        {"type": "dinner", "name": "晚餐推荐", "description": "晚餐描述", "estimated_cost": 80}
      ]
    }
  ],
  "weather_info": [
    {
      "date": "YYYY-MM-DD",
      "day_weather": "晴",
      "night_weather": "多云",
      "day_temp": 25,
      "night_temp": 15,
      "wind_direction": "南风",
      "wind_power": "1-3级"
    }
  ],
  "overall_suggestions": "总体建议",
  "budget": {
    "total_attractions": 180,
    "total_hotels": 1200,
    "total_meals": 480,
    "total_transportation": 200,
    "total": 2060
  }
}
```

**重要提示:**
1. weather_info数组必须包含每一天的天气信息
2. 温度必须是纯数字(不要带°C等单位)
3. 每天安排2-3个景点
4. 考虑景点之间的距离和游览时间
5. 每天必须包含早中晚三餐
6. 提供实用的旅行建议
7. **必须包含预算信息**:
   - 景点门票价格(ticket_price)
   - 餐饮预估费用(estimated_cost)
   - 酒店预估费用(estimated_cost)
   - 预算汇总(budget)包含各项总费用
"""


class MultiAgentTripPlanner:
    """多智能体旅行规划系统"""

    def __init__(self):
        """初始化多智能体系统"""
        print("🔄 开始初始化多智能体旅行规划系统...")

        try:
            self.settings = get_settings()
            self.llm = get_llm()

            # 创建共享的MCP工具(只创建一次)
            print("  - 创建共享MCP工具...")
            
            # 创建景点搜索Agent
            print("  - 创建景点搜索Agent...")
            self.attraction_agent = SimpleAgent(
                name="景点搜索专家",
                llm=self.llm,
                system_prompt=ATTRACTION_AGENT_PROMPT
            )
            
            # 创建天气查询Agent
            print("  - 创建天气查询Agent...")
            self.weather_agent = SimpleAgent(
                name="天气查询专家",
                llm=self.llm,
                system_prompt=WEATHER_AGENT_PROMPT
            )
            # self.weather_agent.add_tool(self.amap_tool)

            # 创建酒店推荐Agent
            print("  - 创建酒店推荐Agent...")
            self.hotel_agent = SimpleAgent(
                name="酒店推荐专家",
                llm=self.llm,
                system_prompt=HOTEL_AGENT_PROMPT
            )
            # self.hotel_agent.add_tool(self.amap_tool)

            # 创建行程规划Agent(不需要工具)
            print("  - 创建行程规划Agent...")
            self.planner_agent = SimpleAgent(
                name="行程规划专家",
                llm=self.llm,
                system_prompt=PLANNER_AGENT_PROMPT
            )
            # 在 __init__ 方法的 try 块最后加入：
            print("  - 创建行程审查Agent...")
            self.reviewer_agent = SimpleAgent(
                name="行程审查专家",
                llm=self.llm,
                system_prompt=REVIEWER_AGENT_PROMPT
            )
            print(f"✅ 多智能体系统初始化成功")
            print(f"   景点搜索Agent: {len(self.attraction_agent.list_tools())} 个工具")
            print(f"   天气查询Agent: {len(self.weather_agent.list_tools())} 个工具")
            print(f"   酒店推荐Agent: {len(self.hotel_agent.list_tools())} 个工具")

        except Exception as e:
            print(f"❌ 多智能体系统初始化失败: {str(e)}")
            import traceback
            traceback.print_exc()
            raise
    
    async def initialize_mcp(self):
       
        print("🔌 正在通过 LangChain MCP 适配器拉起高德地图服务...")
        
        client = MultiServerMCPClient(
            connections={
                "amap": {
                    "command": "uvx",
                    "args": ["amap-mcp-server"],
                    "transport": "stdio",
                    "env": {"AMAP_MAPS_API_KEY": self.settings.amap_api_key}
                }
            },
            # tool_name_prefix=True  # 💡如果设为 True，工具名会变成 amap_xxxx，防止多服务器工具重名
        )
        
        print("🛰️ 正在为 [amap] 显式建立 Session 长连接隧道...")
        # 3. 按照源码注释示例，显式开启针对 "amap" 的会话
        async with client.session("amap") as session:
            
            # 4. 配合官方提供的 load_mcp_tools 函数，把当前会话里的所有子工具全量拉出
            # 这里天然对应了你原本的 auto_expand=True 逻辑，直接平铺开
            amap_langchain_tools = await load_mcp_tools(session)
            
            # 5. 遍历并热加载到景点 Agent 中
            for tool in amap_langchain_tools:
                self.attraction_agent.add_tool(tool)
                self.weather_agent.add_tool(tool)
                self.hotel_agent.add_tool(tool)
                
            print(f"🎉 高德地图子工具挂载成功！生命周期已交由 LangChain 引擎全自动按需托管。当前可用工具: {self.attraction_agent.list_tools()}")
            
            

    async def plan_trip_new(self, request: TripRequest) -> TripPlan:
        
        """
        使用【高并发 Execute + 动态上下文干预 + Plan-Review 反思闭环】生成旅行计划
        """
        try:
            print(f"\n{'='*60}")
            print(f"🚀 开始 [并发异步 + Plan-Execute-Review] 协同规划系统...")
            print(f"目的地: {request.city} | 天数: {request.travel_days}天")
            print(f"{'='*60}\n")

            # ========================================================
            # --- 1. Execute 阶段：天气与景点【并发执行】（Join汇合点） ---
            # ========================================================
            await self.initialize_mcp()
            print("🌤️ 📍 [并发启动] 正在同步请求天气数据与基础景点数据...")
            
            weather_query = f"请查询{request.city}的天气信息"
            attraction_query = self._build_attraction_query(request)
            
            # 创建并发任务
            weather_task = asyncio.create_task(self.run_agent_async(self.weather_agent, weather_query))
            attraction_task = asyncio.create_task(self.run_agent_async(self.attraction_agent, attraction_query))
            
            # 汇合阻塞点：等待两个最耗时的 I/O 操作同时返回
            weather_response, attraction_response = await asyncio.gather(weather_task, attraction_task)
            print(f"天气查询结果: {weather_response}\n")
            print(f"景点查询结果: {attraction_response}\n")
            print("✅ 天气数据与基础景点数据并发获取成功！进入数据汇合流。")

            # ========================================================
            # --- 2. 依赖执行阶段：酒店周边搜索（引入天气与景点双重干预） ---
            # ========================================================
            print("🏨 步骤3: 酒店专家基于景点坐标簇与天气背景进行精准推荐...")
            # 构建融合了“天气”和“景点坐标”的酒店增强Query
            hotel_query = self._build_enhanced_hotel_query(request, attraction_response, weather_response)
            hotel_response = await self.hotel_agent.arun(hotel_query)

            # ========================================================
            # --- 3. Plan & Review 迭代反思闭环控制流 ---
            # ========================================================
            max_iterations = 3  # 最大反思重试次数
            current_iteration = 1
            failed_experiences = []
            max_budget = getattr(request, "max_budget", 3000) 

            while current_iteration <= max_iterations:
                print(f"\n🔄 --- 第 {current_iteration} 轮 规划与并发审查循环 ---")
                
                # 动态构建带有失败教训、并发天气、基础景点的终极 Planner Query
                planner_query = self._build_smart_planner_query_v3(
                    request, attraction_response, weather_response, hotel_response, failed_experiences
                )
                
                print("📋 [Plan] 行程规划专家正在根据天气干预编排方案...")
                planner_response = await self.run_agent_async(self.planner_agent, planner_query)
                
                # 尝试解析 JSON 结构
                try:
                    trip_plan = self._parse_response(planner_response, request)
                except Exception as parse_err:
                    print(f"⚠️ 规划生成的 JSON 结构有误，触发重试: {str(parse_err)}")
                    failed_experiences.append(f"第 {current_iteration} 次尝试生成的 JSON 结构非法，请务必严格输出标准的 JSON 代码块。")
                    current_iteration += 1
                    continue

                # --- 双轨制并发审查（本地代码物理计算 + 远端LLM语义审查） ---
                print("🧐 [Review] 触发双轨制审查（物理规则与大模型专家同步评判）...")
                
                # 异步启动大模型审查专家
                reviewer_query = f"""
                原始用户需求: 城市={request.city}, 偏好={request.preferences}
                当前天气背景: {weather_response}
                当前生成的行程草案:
                {planner_response}
                """
                reviewer_task = asyncio.create_task(self.run_agent_async(self.reviewer_agent, reviewer_query))
                
                # 本地 CPU 毫不阻塞地运行硬编码规则卡点（预算、距离）
                is_valid, physical_feedback = self._run_physical_review(trip_plan, max_budget)
                
                # 等待大模型专家审查完成
                reviewer_response = await reviewer_task
                print(f"⚖️ 审查报告汇合完毕。")
                print(f"第{current_iteration}轮 规划审核结果{planner_response}")

                # 判定裁决闭环
                if "[STATUS: PASSED]" in reviewer_response and is_valid:
                    print(f"🎉 经过 {current_iteration} 轮迭代，行程完美对齐所有约束条件，通过审查！")
                    
                    return trip_plan
                else:
                    print(f"❌ 第 {current_iteration} 轮审查未通过。正在注入失败经验...")
                    
                    combined_feedback = f"【第 {current_iteration} 次失败尝试的审查意见】：\n"
                    if not is_valid:
                        combined_feedback += f"硬性物理卡点未通过：{physical_feedback}\n"
                    
                    advice_part = reviewer_response.split("原因与修改建议：")[-1] if "原因与修改建议：" in reviewer_response else reviewer_response
                    combined_feedback += f"审查专家语义意见：{advice_part.strip()}"
                    
                    failed_experiences.append(combined_feedback)
                    current_iteration += 1

            print("⚠️ 达到最大反思次数限制，未能收敛出完美方案，返回最后一轮的折中草案。")
            return trip_plan

        except Exception as e:
            print(f"❌ 系统核心运行异常: {str(e)}")
            import traceback
            traceback.print_exc()
            return self._create_fallback_plan(request)

    def plan_trip(self, request: TripRequest) -> TripPlan:
        """
        使用多智能体协作生成旅行计划

        Args:
            request: 旅行请求

        Returns:
            旅行计划
        """
        try:
            print(f"\n{'='*60}")
            print(f"🚀 开始多智能体协作规划旅行...")
            print(f"目的地: {request.city}")
            print(f"日期: {request.start_date} 至 {request.end_date}")
            print(f"天数: {request.travel_days}天")
            print(f"偏好: {', '.join(request.preferences) if request.preferences else '无'}")
            print(f"{'='*60}\n")

            # 步骤1: 景点搜索Agent搜索景点
            print("📍 步骤1: 搜索景点...")
            attraction_query = self._build_attraction_query(request)
            attraction_response = self.attraction_agent.run(attraction_query)
            print(f"景点搜索结果: {attraction_response}...\n")

            # 步骤2: 天气查询Agent查询天气
            print("🌤️  步骤2: 查询天气...")
            weather_query = f"请查询{request.city}的天气信息"
            weather_response = self.weather_agent.run(weather_query)
            print(f"天气查询结果: {weather_response}...\n")

            # 步骤3: 酒店推荐Agent搜索酒店
            print("🏨 步骤3: 搜索酒店...")
            hotel_query = f"请搜索{request.city}的{request.accommodation}酒店"
            hotel_response = self.hotel_agent.run(hotel_query)
            print(f"酒店搜索结果: {hotel_response}...\n")

            #改为并发执行
            # 将同步的 agent.run 包装为可等待的协程
            # async def run_attraction():
            #     return await asyncio.to_thread(self.attraction_agent.run, attraction_query)
            
            # async def run_weather():
            #     return await asyncio.to_thread(self.weather_agent.run, weather_query)
            
            # async def run_hotel():
            #     return await asyncio.to_thread(self.hotel_agent.run, hotel_query)
            
            # # 并发执行三个任务
            # attraction_response, weather_response, hotel_response = await asyncio.gather(
            #     run_attraction(),
            #     run_weather(),
            #     run_hotel()
            # )
            # 步骤4: 行程规划Agent整合信息生成计划
            print("📋 步骤4: 生成行程计划...")
            planner_query = self._build_planner_query(request, attraction_response, weather_response, hotel_response)
            planner_response = self.planner_agent.run(planner_query)
            print(f"行程规划结果: {planner_response[:300]}...\n")

            # 解析最终计划
            trip_plan = self._parse_response(planner_response, request)

            print(f"{'='*60}")
            print(f"✅ 旅行计划生成完成!")
            print(f"{'='*60}\n")

            return trip_plan

        except Exception as e:
            print(f"❌ 生成旅行计划失败: {str(e)}")
            import traceback
            traceback.print_exc()
            return self._create_fallback_plan(request)
    
    async def run_agent_async(self, agent, query: str) -> str:
        """异步运行Agent的辅助垫片（如果Agent本身没有run_async，则通过线程池异步化）"""
        if hasattr(agent, "arun"):
            return await agent.arun(query)
        else:
            # 强行将同步的阻塞I/O转为异步协程
            return await asyncio.to_thread(agent.run, query)

    
    def _build_enhanced_hotel_query(self, request: TripRequest, attraction_results: str, weather_info: str) -> str:
        """构建融合了景点坐标与天气双重干预的酒店推荐 Query"""
        return f"""你现在是酒店推荐专家。用户的住宿偏好为: {request.accommodation}。
        
【🚨 汇合上下文A：已选定的基础景点分布】
{attraction_results}

【🚨 汇合上下文B：当前目的地的天气状况】
{weather_info}

【思考与决策要求】:
1. 请分析景点数据中的 `location` 坐标簇，计算出一个几何中心区域或选择核心景点作为锚点，进行周边搜索（Around Search）。
2. 请观察天气状况。如果是恶劣天气（如连续暴雨），请在工具调用和文字推荐时，倾向于选择交通便利、距离核心景点物理直线距离在 5 公里以内、且配套室内设施完善的优质酒店。

请立即调用工具（必须在参数中包含提取到的经纬度）：
`[TOOL_CALL:amap_maps_text_search:keywords=酒店,city={request.city}]`"""


    def _build_smart_planner_query_v3(self, request: TripRequest, attraction_results: str, weather_info: str, hotel_results: str, failed_experiences: List[str]) -> str:
        """构建最终用于规划专家的终极动态 Prompt，显式要求其根据天气调整和反思"""
        # 1. 基础要求与输入物料
        query = f"""请根据以下汇合信息，为用户生成 {request.city} 的 {request.travel_days} 天旅行计划。
        
**【当前环境天气预测】**:
{weather_info}

**【供选择的基础景点池】**:
{attraction_results}

**【供选择的周边酒店池】**:
{hotel_results}

**【核心编排干预规则】**:
你必须展现强大的规划决策能力：仔细阅读上面的天气预测。如果某一天下雨，请将景点池中的【室内景点】（如博物馆、科技馆）优先编排进那一天。如果是晴天，则可以编排公园、山岳等户外景点。
"""
        # 2. 动态注入历史失败教训（反思闭环）
        if failed_experiences:
            query = f"""\n# 🚨 CRITICAL: 历史规划失败教训与反思
你在前几次的行程生成中被审查专家驳回了。**请在本次重新编排时，必须彻底吸取以下教训，对景点和酒店进行重新对齐和降级调整**：
""" + "\n".join(failed_experiences) + "\n\n" + query
            
        return query
    def _run_physical_review(self, plan: TripPlan, max_budget: float) -> (bool, str):
        """利用代码对预算、酒店地理距离进行硬编码审查"""
        feedbacks = []
        is_valid = True
        
        # 1. 审查预算
        total_cost = plan.budget.total if plan.budget else 0
        if total_cost > max_budget:
            is_valid = False
            feedbacks.append(f"- 预算超支：当前计算的总预算为 {total_cost} 元，超过了用户上限 {max_budget} 元。")

        # 2. 审查酒店与景点的距离分布
        for day in plan.days:
            if not day.hotel or not day.attractions:
                continue
            
            h_loc = day.hotel.location
            for attr in day.attractions:
                a_loc = attr.location
                # 计算酒店到该日每个景点的直线距离
                dist = self.calculate_distance(h_loc.longitude, h_loc.latitude, a_loc.longitude, a_loc.latitude)
                if dist > 25.0:  # 超过25公里判定为过远
                    is_valid = False
                    feedbacks.append(f"- 酒店安排不合理：第 {day.day_index + 1} 天选择的酒店 [{day.hotel.name}] 距离景点 [{attr.name}] 有 {dist:.1f} 公里，实在太远了，会导致用户把时间浪费在路上。")
                    
        if is_valid:
            return True, "物理硬性审查通过（预算与距离均在合理范围内）。"
        else:
            return False, "\n".join(feedbacks)
    
    @staticmethod
    def calculate_distance(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
        import math
        """计算两点之间的球面距离（单位：公里）"""
        R = 6371.0  # 地球半径
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        delta_phi = math.radians(lat2 - lat1)
        delta_lambda = math.radians(lon2 - lon1)
        a = math.sin(delta_phi / 2.0)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0)**2
        c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
        return R * c

    def _build_smart_planner_query(self, request: TripRequest, attractions: str, weather: str, hotels: str, failed_experiences: List[str]) -> str:
        """构建带有历史失败反思的动态规划提示词"""
        # 继承原有的基础 prompt
        base_query = self._build_planner_query(request, attractions, weather, hotels)
        
        if not failed_experiences:
            return base_query
            
        # 如果有失败经验，在 Prompt 头部强势插入反思要求
        reflection_block = f"""\n
# 🚨 CRITICAL: 历史规划失败教训与反思
你在前几次的生成中犯了错误，被审查专家驳回了。**请在本次重新规划时，必须彻底吸取以下教训，避免重蹈覆辙**：
"""
        for exp in failed_experiences:
            reflection_block += f"\n{exp}\n"
            
        reflection_block += "\n请根据上述驳回意见，重新调整景点的空间搭配、错开下雨天的户外活动，或者降级酒店/餐厅以控制预算！\n"
        
        return reflection_block + base_query

        

    def _build_attraction_query(self, request: TripRequest) -> str:
        """构建景点搜索查询 - 直接包含工具调用"""
        keywords = []
        if request.preferences:
            # 只取第一个偏好作为关键词
            keywords = request.preferences[0]
        else:
            keywords = "景点"

        # 直接返回工具调用格式
        query = f"请使用maps_text_search工具搜索{request.city}的{keywords}相关景点。\n[TOOL_CALL:maps_text_search:keywords={keywords},city={request.city}]"
        return query

    def _build_planner_query(self, request: TripRequest, attractions: str, weather: str, hotels: str = "") -> str:
        """构建行程规划查询"""
        query = f"""请根据以下信息生成{request.city}的{request.travel_days}天旅行计划:

**基本信息:**
- 城市: {request.city}
- 日期: {request.start_date} 至 {request.end_date}
- 天数: {request.travel_days}天
- 交通方式: {request.transportation}
- 住宿: {request.accommodation}
- 偏好: {', '.join(request.preferences) if request.preferences else '无'}

**景点信息:**
{attractions}

**天气信息:**
{weather}

**酒店信息:**
{hotels}

**要求:**
1. 每天安排2-3个景点
2. 每天必须包含早中晚三餐
3. 每天推荐一个具体的酒店(从酒店信息中选择)
3. 考虑景点之间的距离和交通方式
4. 返回完整的JSON格式数据
5. 景点的经纬度坐标要真实准确
"""
        if request.free_text_input:
            query += f"\n**额外要求:** {request.free_text_input}"

        return query
    
    def _parse_response(self, response: str, request: TripRequest) -> TripPlan:
        """
        解析Agent响应
        
        Args:
            response: Agent响应文本
            request: 原始请求
            
        Returns:
            旅行计划
        """
        try:
            # 尝试从响应中提取JSON
            # 查找JSON代码块
            if "```json" in response:
                json_start = response.find("```json") + 7
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            elif "```" in response:
                json_start = response.find("```") + 3
                json_end = response.find("```", json_start)
                json_str = response[json_start:json_end].strip()
            elif "{" in response and "}" in response:
                # 直接查找JSON对象
                json_start = response.find("{")
                json_end = response.rfind("}") + 1
                json_str = response[json_start:json_end]
            else:
                raise ValueError("响应中未找到JSON数据")
            
            # 解析JSON
            data = json.loads(json_str)
            
            # 转换为TripPlan对象
            trip_plan = TripPlan(**data)
            
            return trip_plan
            
        except Exception as e:
            print(f"⚠️  解析响应失败: {str(e)}")
            print(f"   将使用备用方案生成计划")
            return self._create_fallback_plan(request)
    
    def _create_fallback_plan(self, request: TripRequest) -> TripPlan:
        """创建备用计划(当Agent失败时)"""
        from datetime import datetime, timedelta
        
        # 解析日期
        start_date = datetime.strptime(request.start_date, "%Y-%m-%d")
        
        # 创建每日行程
        days = []
        for i in range(request.travel_days):
            current_date = start_date + timedelta(days=i)
            
            day_plan = DayPlan(
                date=current_date.strftime("%Y-%m-%d"),
                day_index=i,
                description=f"第{i+1}天行程",
                transportation=request.transportation,
                accommodation=request.accommodation,
                attractions=[
                    Attraction(
                        name=f"{request.city}景点{j+1}",
                        address=f"{request.city}市",
                        location=Location(longitude=116.4 + i*0.01 + j*0.005, latitude=39.9 + i*0.01 + j*0.005),
                        visit_duration=120,
                        description=f"这是{request.city}的著名景点",
                        category="景点"
                    )
                    for j in range(2)
                ],
                meals=[
                    Meal(type="breakfast", name=f"第{i+1}天早餐", description="当地特色早餐"),
                    Meal(type="lunch", name=f"第{i+1}天午餐", description="午餐推荐"),
                    Meal(type="dinner", name=f"第{i+1}天晚餐", description="晚餐推荐")
                ]
            )
            days.append(day_plan)
        
        return TripPlan(
            city=request.city,
            start_date=request.start_date,
            end_date=request.end_date,
            days=days,
            weather_info=[],
            overall_suggestions=f"这是为您规划的{request.city}{request.travel_days}日游行程,建议提前查看各景点的开放时间。"
        )


# 全局多智能体系统实例
_multi_agent_planner = None


def get_trip_planner_agent() -> MultiAgentTripPlanner:
    """获取多智能体旅行规划系统实例(单例模式)"""
    global _multi_agent_planner

    if _multi_agent_planner is None:
        _multi_agent_planner = MultiAgentTripPlanner()

    return _multi_agent_planner


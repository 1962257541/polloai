from app.services.doubao_context_template import (
    build_context_template,
    compare_payload_to_template,
    load_latest_context_template,
    save_context_template,
)


def _payload(conversation_id="conv-real", duration=10):
    return {
        "client_meta": {
            "local_conversation_id": "local-1",
            "conversation_id": conversation_id,
            "bot_id": "bot",
            "last_section_id": "section",
            "last_message_index": 2,
        },
        "messages": [
            {
                "local_message_id": "msg",
                "content_type": 9999,
                "skill": {"skill_type": 1},
                "content_block": [{"type": 10052}, {"type": 2001}],
                "attachments": [{"file_key": "key"}],
                "ext": {"chat_ability": "{}"},
            }
        ],
        "chat_ability": {
            "ability_type": 17,
            "ability_param": f'{{"duration":{duration},"model":"seedance_v2.0"}}',
        },
        "option": {"need_create_conversation": False},
    }


def test_context_template_redacts_and_compares(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    template = build_context_template(
        account_index=0,
        profile_id="profile",
        request_url="https://www.doubao.com/chat/completion?msToken=secret&a_bogus=sig&web_tab_id=tab",
        method="POST",
        headers={"Cookie": "secret", "Content-Type": "application/json"},
        payload=_payload(),
    )
    paths = save_context_template(template)

    loaded = load_latest_context_template(0)
    assert loaded is not None
    assert "secret" not in loaded["request"]["url"]
    assert loaded["request"]["headers"]["Cookie"] == "[REDACTED]"
    assert paths["latest_path"].endswith("account-0-latest.json")

    comparison = compare_payload_to_template(_payload(conversation_id="", duration=5), loaded)
    assert comparison["template_found"] is True
    assert comparison["difference_count"] >= 2
    assert any("client_meta.conversation_id" in item for item in comparison["differences"])
    assert any("ability_param" in item for item in comparison["differences"])
